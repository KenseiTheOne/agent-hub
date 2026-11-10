// Entry point: headless diagnostic mode (--probe-*) or the regular menu bar app.
if Probe.wanted {
    Probe.run()
} else {
    AgentHubApp.main()
}
