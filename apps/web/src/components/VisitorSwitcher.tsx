import { useVisitor } from '../contexts/useVisitor';

export function VisitorSwitcher() {
  const {
    visitors,
    activeVisitor,
    selectVisitor,
    addVisitor,
  } = useVisitor();

  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor="visitor-select"
        className="text-sm text-slate-400"
      >
        Visitor
      </label>

      <select
        id="visitor-select"
        value={activeVisitor.id}
        onChange={(event) => selectVisitor(event.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
      >
        {visitors.map((visitor) => (
          <option key={visitor.id} value={visitor.id}>
            {visitor.name}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={addVisitor}
        className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
      >
        + Add visitor
      </button>
    </div>
  );
}
