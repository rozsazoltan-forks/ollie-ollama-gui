// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Disable WebKit DMA-BUF renderer to prevent EGL crashes on systems with
  // broken gvfs/GLib ABI (Ubuntu 26.04, some Arch configs). Must be set
  // before WebKit initializes.
  #[cfg(target_os = "linux")]
  {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }
  app_lib::run();
}
