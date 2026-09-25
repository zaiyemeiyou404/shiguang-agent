export function ArtifactPanel({ artifacts, onOpen }: { artifacts: { id: string; title: string; uri: string }[]; onOpen: (uri: string) => void }) {
  return <section className="artifact-panel"><h2>产物</h2>{artifacts.length ? <ul>{artifacts.map((artifact) => <li key={artifact.id}><button className="tool-btn" onClick={() => onOpen(artifact.uri)} type="button">{artifact.title}</button></li>)}</ul> : <p className="muted">当前没有产物。</p>}</section>;
}
