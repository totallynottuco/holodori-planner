use std::{borrow::Cow, fs, path::PathBuf};
use tauri::{
    utils::assets::{AssetKey, AssetsIter, CspHash},
    Assets, Runtime,
};

/// Large media files are installed beside the executable and read only on demand.
/// Tauri still owns the app origin, MIME handling, and embedded UI.
pub struct OutfitAssets<R: Runtime> {
    pub embedded: Box<dyn Assets<R>>,
    pub directory: PathBuf,
}

impl<R: Runtime> Assets<R> for OutfitAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let (directory, name, extensions, index_fallback) =
            if let Some(name) = key.as_ref().strip_prefix("/assets/outfits/") {
                (self.directory.clone(), name, &[".webp", ".gz"][..], false)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/outfit-updates/") {
                (self.directory.with_file_name("outfit-updates"), name, &[".webp", ".gz"][..], true)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/chart-artwork/") {
                (self.directory.with_file_name("chart-artwork"), name, &[".png"][..], true)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/team-optimizer/soundtracks/") {
                (self.directory.with_file_name("soundtracks"), name, &[".ogg"][..], true)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/team-optimizer/soundtrack-updates/") {
                (self.directory.with_file_name("soundtrack-updates"), name, &[".ogg"][..], true)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/team-optimizer/hit-sound-updates/") {
                (self.directory.with_file_name("hit-sound-updates"), name, &[".wav"][..], true)
            } else if let Some(name) = key.as_ref().strip_prefix("/assets/team-optimizer/jacket-updates/") {
                (self.directory.with_file_name("jacket-updates"), name, &[".webp"][..], true)
            } else {
                return self.embedded.get(key);
            };
        if name.is_empty()
            || name.contains("..")
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || !(name == "index.json" || extensions.iter().any(|extension| name.ends_with(extension)))
        {
            return None;
        }
        let read = || {
            let root = directory.canonicalize().ok()?;
            let file = root.join(name).canonicalize().ok()?;
            if file.parent()? != root {
                return None;
            }
            fs::read(file).ok().map(Cow::Owned)
        };
        read().or_else(|| {
            (index_fallback && name == "index.json")
                .then(|| self.embedded.get(key))
                .flatten()
        })
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}
