import type { DesktopArtifact } from "../../bridge";

function isHttp(uri: string) { return /^https?:\/\//i.test(uri); }

export function ArtifactCard({ artifact, onCopy, onOpen, onReveal, onSelectRun }: {
  artifact: DesktopArtifact;
  onCopy: (uri: string) => void;
  onOpen: (uri: string) => void;
  onReveal: (uri: string) => void;
  onSelectRun?: (runId: string) => void;
}) {
  return (
    <article className="inspector-artifact-card">
      <div><span>{artifact.kind}</span><h5>{artifact.title || artifact.uri.split(/[\\/]/).pop() || "未命名产物"}</h5><p>{artifact.uri}</p></div>
      <div className="inspector-card-actions">
        {artifact.runId && onSelectRun ? <button type="button" onClick={() => onSelectRun(artifact.runId!)}>查看运行</button> : null}
        <button type="button" onClick={() => onCopy(artifact.uri)}>复制地址</button>
        <button type="button" onClick={() => onOpen(artifact.uri)}>{isHttp(artifact.uri) ? "打开链接" : "打开"}</button>
        {!isHttp(artifact.uri) ? <button type="button" onClick={() => onReveal(artifact.uri)}>定位</button> : null}
      </div>
    </article>
  );
}
