// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // Prevent WebKit EGL crashes on Ubuntu 26.04 / Mesa 24+ where
  // eglGetDisplay(EGL_DEFAULT_DISPLAY) returns EGL_BAD_PARAMETER and aborts.
  // DMABUF flag alone is insufficient — compositing also initializes EGL.
  // Both must be set before WebKit initializes.
  #[cfg(target_os = "linux")]
  {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
  }
  app_lib::run();
}
