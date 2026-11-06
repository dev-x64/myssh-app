// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by a coding agent as its MCP server, not as the app.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        myssh_lib::agent_bridge();
        return;
    }
    myssh_lib::run()
}
