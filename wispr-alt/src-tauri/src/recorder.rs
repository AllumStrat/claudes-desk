//! Microphone capture on its own thread.
//!
//! cpal streams can't move between threads on macOS, so one thread owns the
//! stream and the rest of the app talks to it over a channel.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

/// Ten minutes at 48 kHz stereo; anything longer is almost surely a stuck key.
const MAX_SAMPLES: usize = 48_000 * 2 * 60 * 10;

pub struct Recording {
    pub samples: Vec<f32>,
    pub rate: u32,
    pub channels: u16,
    pub device: String,
}

enum Cmd {
    Start(Option<String>, Sender<Result<String>>),
    Stop(Sender<Option<Recording>>),
}

pub struct Recorder {
    tx: Sender<Cmd>,
}

struct Active {
    _stream: cpal::Stream,
    buf: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: u16,
    device: String,
}

impl Recorder {
    pub fn new() -> Recorder {
        let (tx, rx) = channel::<Cmd>();
        std::thread::Builder::new()
            .name("recorder".into())
            .spawn(move || {
                let mut active: Option<Active> = None;
                for cmd in rx {
                    match cmd {
                        Cmd::Start(device, reply) => {
                            active = None;
                            let res = open(device.as_deref()).map(|a| {
                                let name = a.device.clone();
                                active = Some(a);
                                name
                            });
                            let _ = reply.send(res);
                        }
                        Cmd::Stop(reply) => {
                            let rec = active.take().map(|a| {
                                drop(a._stream);
                                let samples = std::mem::take(&mut *a.buf.lock().unwrap());
                                Recording { samples, rate: a.rate, channels: a.channels, device: a.device }
                            });
                            let _ = reply.send(rec);
                        }
                    }
                }
            })
            .expect("couldn't start the recorder thread");
        Recorder { tx }
    }

    /// Starts recording from the named input (or the system default).
    /// Returns the device name actually used.
    pub fn start(&self, device: Option<String>) -> Result<String> {
        let (tx, rx) = channel();
        self.tx.send(Cmd::Start(device, tx)).map_err(|_| anyhow!("recorder stopped"))?;
        rx.recv().map_err(|_| anyhow!("recorder stopped"))?
    }

    /// Stops and returns what was captured, if a recording was running.
    pub fn stop(&self) -> Option<Recording> {
        let (tx, rx) = channel();
        self.tx.send(Cmd::Stop(tx)).ok()?;
        rx.recv().ok()?
    }
}

pub fn input_devices() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

fn open(wanted: Option<&str>) -> Result<Active> {
    let host = cpal::default_host();
    let device = match wanted {
        Some(name) => host
            .input_devices()?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    }
    .context("no microphone found")?;
    let name = device.name().unwrap_or_else(|_| "microphone".into());
    let config = device
        .default_input_config()
        .context("couldn't read the microphone's format")?;
    let rate = config.sample_rate().0;
    let channels = config.channels();
    let buf = Arc::new(Mutex::new(Vec::with_capacity(rate as usize * channels as usize * 30)));

    let stream_config: cpal::StreamConfig = config.clone().into();
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&device, &stream_config, buf.clone()),
        cpal::SampleFormat::I16 => build::<i16>(&device, &stream_config, buf.clone()),
        cpal::SampleFormat::U16 => build::<u16>(&device, &stream_config, buf.clone()),
        cpal::SampleFormat::I32 => build::<i32>(&device, &stream_config, buf.clone()),
        cpal::SampleFormat::F64 => build::<f64>(&device, &stream_config, buf.clone()),
        other => Err(anyhow!("unsupported microphone sample format {other:?}")),
    }?;
    stream.play().context("couldn't start the microphone")?;
    Ok(Active { _stream: stream, buf, rate, channels, device: name })
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buf: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            if let Ok(mut b) = buf.lock() {
                if b.len() < MAX_SAMPLES {
                    b.extend(data.iter().map(|s| s.to_sample::<f32>()));
                }
            }
        },
        |err| eprintln!("microphone error: {err}"),
        None,
    )?;
    Ok(stream)
}
