//! What this process is using each GPU engine for, read from the same counters Task Manager shows.
//!
//! A card has several independent engines - 3D, video encode, video decode, video processing, copy
//! - and Task Manager's single "GPU" percentage is the *largest* of them, not their sum. So a
//! share that reads 40% might be 40% of the encoder and nothing else, or 40% of the 3D engine a
//! game is trying to use, and those two have completely different answers. Nothing else this crate
//! can measure tells the difference.
//!
//! Diagnostics only. Nothing on the publishing path opens a PDH query.

use std::collections::BTreeMap;

use windows::core::PCWSTR;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
};

/// A PDH query over every GPU engine this process is using.
pub struct GpuEngines {
    query: isize,
    counter: isize,
    /// Matched against each counter instance, which carries the owning process id.
    prefix: String,
}

impl GpuEngines {
    /// Open the counter for the current process.
    pub fn for_this_process() -> Result<Self, String> {
        let pid = std::process::id();
        let mut query = 0isize;
        // A null data source means live counters.
        let status = unsafe { windows::Win32::System::Performance::PdhOpenQueryW(PCWSTR::null(), 0, &mut query) };
        if status != 0 {
            return Err(format!("PdhOpenQueryW failed: 0x{status:x}"));
        }

        // The wildcard instance is the only practical way in: the real instance names carry the
        // adapter LUID and the engine index, neither of which is knowable up front.
        let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0"
            .encode_utf16()
            .collect();
        let mut counter = 0isize;
        let status =
            unsafe { PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) };
        if status != 0 {
            unsafe { PdhCloseQuery(query) };
            return Err(format!("no GPU Engine counter: 0x{status:x}"));
        }

        let engines = Self {
            query,
            counter,
            prefix: format!("pid_{pid}_"),
        };
        // Utilisation is a rate, so the first collection only establishes a baseline.
        engines.collect();
        Ok(engines)
    }

    fn collect(&self) -> bool {
        unsafe { PdhCollectQueryData(self.query) == 0 }
    }

    /// Utilisation per engine type since the last call, as whole percentages.
    ///
    /// Summed across instances of the same type: a card exposes several engines of one kind and
    /// the driver spreads work over them, so reading one instance under-reports.
    pub fn sample(&self) -> BTreeMap<String, f64> {
        let mut out = BTreeMap::new();
        if !self.collect() {
            return out;
        }

        let mut size = 0u32;
        let mut count = 0u32;
        // First call sizes the buffer, and answers PDH_MORE_DATA rather than success.
        unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                None,
            )
        };
        if size == 0 || count == 0 {
            return out;
        }

        // PDH writes an array of items plus their instance-name strings into one buffer, so it is
        // sized in bytes and read back as items.
        let mut buffer =
            vec![0u8; size as usize + std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>()];
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buffer.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W),
            )
        };
        if status != 0 {
            return out;
        }

        // Reading `count` items out of a buffer PDH just filled with exactly that many.
        let items = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W,
                count as usize,
            )
        };

        for item in items {
            let name = unsafe { item.szName.to_string() }.unwrap_or_default();
            if !name.starts_with(&self.prefix) {
                continue;
            }
            let Some(engine) = name.rsplit_once("engtype_").map(|(_, kind)| kind.to_string()) else {
                continue;
            };
            // The union field is only valid when the counter's own status is success.
            let value = unsafe { item.FmtValue.Anonymous.doubleValue };
            if value.is_finite() && value > 0.0 {
                *out.entry(engine).or_insert(0.0) += value;
            }
        }

        out
    }
}

impl Drop for GpuEngines {
    fn drop(&mut self) {
        unsafe { PdhCloseQuery(self.query) };
    }
}
