import Foundation

/// Reads the machine's state (what makes two runs incomparable) with Foundation only.
public enum MachineInfo {
  public static func capture(screenHz: Double) -> Machine {
    var load = [Double](repeating: 0, count: 3)
    getloadavg(&load, 3)
    let p = ProcessInfo.processInfo
    let thermal: String = switch p.thermalState { case .nominal: "nominal"; case .fair: "fair"; case .serious: "serious"; case .critical: "critical"; @unknown default: "unknown" }
    return Machine(model: sysctl("hw.model") ?? "unknown", cores: p.activeProcessorCount, memoryGB: Stats.round(Double(p.physicalMemory) / 1_073_741_824, 1),
                   os: p.operatingSystemVersionString, screenHz: screenHz, loadAvg1: Stats.round(load[0], 2), thermalState: thermal,
                   lowPowerMode: p.isLowPowerModeEnabled, heavyProcesses: heavyProcesses())
  }

  static func sysctl(_ name: String) -> String? {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
    return String(cString: buf)
  }

  /// Other processes above 25 % of a core right now ("WindowServer 48%"), the top five.
  static func heavyProcesses() -> [String] {
    #if os(macOS)
    let me = ProcessInfo.processInfo.processIdentifier
    let ps = Process(); ps.executableURL = URL(fileURLWithPath: "/bin/ps"); ps.arguments = ["-Aro", "pid=,pcpu=,comm="]
    let out = Pipe(); ps.standardOutput = out; ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile(); ps.waitUntilExit()
    return String(decoding: data, as: UTF8.self).split(separator: "\n").prefix(12).compactMap { line -> String? in
      let f = line.split(separator: " ", omittingEmptySubsequences: true)
      guard f.count >= 3, let pid = Int32(f[0]), pid != me, let cpu = Double(f[1]), cpu >= 25 else { return nil }
      let name = f[2...].joined(separator: " ").split(separator: "/").last.map(String.init) ?? String(f[2])
      return "\(name) \(Int(cpu))%"
    }.prefix(5).map { $0 }
    #else
    return []
    #endif
  }
}
