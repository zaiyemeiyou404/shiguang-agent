export function ToolPanel({ events }: { events: { id: string; label: string; detail?: string }[] }) {
  return <section className="tool-panel"><h2>工具</h2>{events.length ? <ul>{events.map((event) => <li key={event.id}><strong>{event.label}</strong>{event.detail ? <small>{event.detail}</small> : null}</li>)}</ul> : <p className="muted">暂无工具事件。</p>}</section>;
}
