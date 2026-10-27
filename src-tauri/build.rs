fn main() {
    // 无头（`--no-default-features`）构建仅用于测试核心逻辑，跳过 Tauri 代码生成。
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
