// 在 Windows 的 release 构建中不弹出额外的控制台窗口，请勿删除。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "desktop")]
    mqtui_lib::run();

    #[cfg(not(feature = "desktop"))]
    eprintln!("该可执行文件需要在 `desktop` 特性下构建");
}
