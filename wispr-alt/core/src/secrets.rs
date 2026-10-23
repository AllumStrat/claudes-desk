//! API keys for the optional cleanup pass live in the macOS Keychain, never
//! in the settings file.

use anyhow::Result;

const SERVICE: &str = "com.allumstrategies.dictate";

fn entry(name: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, name)?)
}

pub fn get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

pub fn set(name: &str, value: &str) -> Result<()> {
    entry(name)?.set_password(value.trim())?;
    Ok(())
}

pub fn delete(name: &str) -> Result<()> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
