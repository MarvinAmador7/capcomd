// The three steps from README "Quickstart": install the CLI, add capcomd to your agent, ask it to set things up.
export function Steps({ className }: { className?: string }) {
  return (
    <ol className={`steps${className ? ` ${className}` : ""}`}>
      <li><b>Install the CLI</b><span>Homebrew, the install script, or Bun.</span></li>
      <li><b>Add it to your agent</b><span>The plugin for Claude Code or Codex; <code>capcomd setup agent</code> for Hermes.</span></li>
      <li><b>Ask for it</b><span>&ldquo;Set up capcomd for this repository.&rdquo; Then ask for the outcome.</span></li>
    </ol>
  );
}
