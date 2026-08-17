//! What a stretch of GPU work actually cost, on the GPU's own clock.
//!
//! Wall-clock timing around a `VideoProcessorBlt` measures how long it took to *queue*, not how
//! long the GPU spent, and every number that matters here is the second one. Timestamp queries are
//! the only instrument that answers it.
//!
//! Diagnostics only. Nothing on the publishing path builds one of these.

use windows::Win32::Graphics::Direct3D11::{
    ID3D11Query, D3D11_QUERY_DATA_TIMESTAMP_DISJOINT, D3D11_QUERY_DESC, D3D11_QUERY_TIMESTAMP,
    D3D11_QUERY_TIMESTAMP_DISJOINT,
};

use super::device::GpuDevice;

/// Brackets a region of GPU work and reports how long it took to drain.
///
/// <p><b>Wall clock against a fence, not a timestamp delta.</b> The obvious instrument is a pair of
/// `D3D11_QUERY_TIMESTAMP`s, and it reads zero here: those stamps are taken on the 3D queue, and a
/// `VideoProcessorBlt` runs on the video-processing engine, so both land at the same value and the
/// work between them is invisible. A disjoint query only completes once the GPU has retired
/// everything queued before it, whichever engine ran it - so waiting on one is a fence, and the
/// wall clock either side of a long enough run of work is that work's cost.</p>
///
/// <p>Queueing overhead is included, which is why callers measure tens of iterations rather than
/// one.</p>
pub struct GpuTimer {
    fence: ID3D11Query,
    started: std::time::Instant,
}

impl GpuTimer {
    pub fn new(device: &GpuDevice) -> Result<Self, String> {
        Ok(Self {
            fence: query(device, D3D11_QUERY_TIMESTAMP_DISJOINT)?,
            started: std::time::Instant::now(),
        })
    }

    /// Open the bracket. Every command queued after this and before [`Self::stop`] is measured.
    pub fn start(&mut self, device: &GpuDevice) {
        unsafe { device.context.Begin(&self.fence) };
        self.started = std::time::Instant::now();
    }

    /// Close the bracket and block until the GPU has retired everything inside it.
    ///
    /// Blocking is right for a diagnostic and wrong for anything else, which is why this type is
    /// not reachable from the publishing path.
    pub fn stop(&self, device: &GpuDevice) -> Option<f64> {
        unsafe { device.context.End(&self.fence) };
        let _: D3D11_QUERY_DATA_TIMESTAMP_DISJOINT = wait_for(device, &self.fence)?;
        Some(self.started.elapsed().as_secs_f64() * 1000.0)
    }
}

fn query(device: &GpuDevice, kind: windows::Win32::Graphics::Direct3D11::D3D11_QUERY) -> Result<ID3D11Query, String> {
    let desc = D3D11_QUERY_DESC {
        Query: kind,
        MiscFlags: 0,
    };
    let mut query = None;
    unsafe { device.device.CreateQuery(&desc, Some(&mut query)) }
        .map_err(|e| format!("could not create a query: {e}"))?;
    query.ok_or_else(|| "CreateQuery returned nothing".to_string())
}

/// Spin until the GPU has caught up with this query.
///
/// Called through the vtable rather than the projection on purpose. `GetData` answers `S_FALSE`
/// while the work is still in flight, and `S_FALSE` is a *success* code - so the safe wrapper's
/// `Result` is `Ok` either way and a caller that trusts it reads an uninitialised value on the
/// first try. Only `S_OK` means the data is there.
fn wait_for<T: Copy + Default>(device: &GpuDevice, query: &ID3D11Query) -> Option<T> {
    use windows::core::Interface;

    let mut value = T::default();
    let size = std::mem::size_of::<T>() as u32;
    let vtable = Interface::vtable(&device.context);
    let context = Interface::as_raw(&device.context);
    let async_query = Interface::as_raw(query);

    // Queued work is not started until the context is flushed, so without this the query never
    // completes and the loop below spins out.
    unsafe { (vtable.Flush)(context) };

    for _ in 0..10_000_000 {
        // Writing `size` bytes into a local of exactly that type and size, through a query and a
        // context the caller holds live.
        let status = unsafe {
            (vtable.GetData)(
                context,
                async_query,
                &mut value as *mut T as *mut core::ffi::c_void,
                size,
                0,
            )
        };
        if status == windows::Win32::Foundation::S_OK {
            return Some(value);
        }
        if status.is_err() {
            return None;
        }
        std::hint::spin_loop();
    }
    None
}
