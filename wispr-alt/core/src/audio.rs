//! Turning raw microphone audio into what Whisper expects.

use crate::WHISPER_SAMPLE_RATE;

/// Whisper.cpp refuses clips shorter than one second, so short ones get
/// padded with silence up to this length.
const MIN_WHISPER_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) * 11 / 10;

/// Below this RMS level a clip is treated as silence and never sent to
/// Whisper (which likes to invent "Thank you." for empty audio).
pub const SILENCE_RMS: f32 = 0.0025;

/// Averages interleaved channels down to one.
pub fn to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels.max(1) as usize;
    if channels == 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Resamples mono audio. Downsampling runs a windowed-sinc low-pass first so
/// 44.1/48 kHz mic audio doesn't alias into the speech band.
pub fn resample(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == to_rate || from_rate == 0 || to_rate == 0 {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let filtered = if ratio > 1.0 {
        // Cutoff a little under the new Nyquist, as a fraction of the old rate.
        low_pass(input, 0.45 / ratio)
    } else {
        input.to_vec()
    };
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            let a = filtered[idx.min(filtered.len() - 1)];
            let b = filtered[(idx + 1).min(filtered.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

/// FIR low-pass with a Blackman-windowed sinc. `cutoff` is in cycles per
/// sample (0.5 is Nyquist).
fn low_pass(input: &[f32], cutoff: f64) -> Vec<f32> {
    let half = ((4.0 / cutoff).ceil() as isize).clamp(8, 256);
    let taps: Vec<f64> = (-half..=half)
        .map(|n| {
            let n = n as f64;
            let sinc = if n == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * n).sin() / (std::f64::consts::PI * n)
            };
            let m = (n + half as f64) / (2.0 * half as f64);
            let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * m).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * m).cos();
            sinc * window
        })
        .collect();
    let sum: f64 = taps.iter().sum();
    let taps: Vec<f32> = taps.iter().map(|t| (t / sum) as f32).collect();

    let len = input.len() as isize;
    (0..len)
        .map(|i| {
            let mut acc = 0.0f32;
            for (k, tap) in taps.iter().enumerate() {
                let j = i + k as isize - half;
                if (0..len).contains(&j) {
                    acc += input[j as usize] * tap;
                }
            }
            acc
        })
        .collect()
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

pub fn is_silent(samples: &[f32]) -> bool {
    rms(samples) < SILENCE_RMS
}

/// Duration of mono audio at `rate`, in milliseconds.
pub fn duration_ms(samples: usize, rate: u32) -> u64 {
    if rate == 0 {
        return 0;
    }
    samples as u64 * 1000 / rate as u64
}

/// Raises quiet recordings toward a healthy level (at most 10x gain).
pub fn normalize(samples: &mut [f32]) {
    let p = peak(samples);
    if p <= 0.0 || p >= 0.5 {
        return;
    }
    let gain = (0.9 / p).min(10.0);
    for s in samples.iter_mut() {
        *s *= gain;
    }
}

/// Full prep: mono, 16 kHz, gain, padded to Whisper's minimum length.
pub fn prepare_for_whisper(interleaved: &[f32], rate: u32, channels: u16) -> Vec<f32> {
    let mono = to_mono(interleaved, channels);
    let mut out = resample(&mono, rate, WHISPER_SAMPLE_RATE);
    normalize(&mut out);
    if out.len() < MIN_WHISPER_SAMPLES {
        out.resize(MIN_WHISPER_SAMPLES, 0.0);
    }
    out
}

/// Reads a WAV file into interleaved f32 samples, returning (samples, rate, channels).
pub fn read_wav(path: &std::path::Path) -> anyhow::Result<(Vec<f32>, u32, u16)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    Ok((samples, spec.sample_rate, spec.channels))
}

/// Writes mono 16 kHz audio as a 16-bit WAV (handy for debugging a dictation).
pub fn write_wav(path: &std::path::Path, samples: &[f32], rate: u32) -> anyhow::Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(path, spec)?;
    for s in samples {
        w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
    }
    w.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, secs: f32, amp: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn mono_averages_channels() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(to_mono(&[0.1, 0.2], 1), vec![0.1, 0.2]);
    }

    #[test]
    fn resample_48k_keeps_speech_band_and_length() {
        let input = sine(440.0, 48_000, 1.0, 0.5);
        let out = resample(&input, 48_000, 16_000);
        assert_eq!(out.len(), 16_000);
        // A 440 Hz tone should come through at about the same level.
        let r = rms(&out[1000..15000]);
        assert!((r - 0.5 / 2f32.sqrt()).abs() < 0.02, "rms {r}");
    }

    #[test]
    fn resample_filters_tones_above_new_nyquist() {
        // 12 kHz can't exist at 16 kHz; without the filter it would alias to 4 kHz.
        let input = sine(12_000.0, 48_000, 1.0, 0.5);
        let out = resample(&input, 48_000, 16_000);
        assert!(rms(&out[1000..15000]) < 0.02);
    }

    #[test]
    fn resample_44100_length() {
        let input = vec![0.0; 44_100 * 2];
        assert_eq!(resample(&input, 44_100, 16_000).len(), 32_000);
    }

    #[test]
    fn short_clips_are_padded_to_whisper_minimum() {
        let input = sine(300.0, 48_000, 0.3, 0.3);
        let out = prepare_for_whisper(&input, 48_000, 1);
        assert_eq!(out.len(), MIN_WHISPER_SAMPLES);
    }

    #[test]
    fn quiet_audio_is_normalized_but_silence_stays_silent() {
        let mut quiet = sine(300.0, 16_000, 0.5, 0.05);
        normalize(&mut quiet);
        assert!((peak(&quiet) - 0.5).abs() < 0.01, "10x gain cap");
        assert!(is_silent(&vec![0.0; 16_000]));
        assert!(!is_silent(&sine(300.0, 16_000, 0.5, 0.1)));
    }

    #[test]
    fn wav_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.wav");
        let input = sine(300.0, 16_000, 0.25, 0.5);
        write_wav(&path, &input, 16_000).unwrap();
        let (back, rate, ch) = read_wav(&path).unwrap();
        assert_eq!((rate, ch, back.len()), (16_000, 1, input.len()));
        assert!((back[100] - input[100]).abs() < 0.001);
    }
}
