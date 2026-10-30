import { useVisitor } from '../contexts/useVisitor';

export function VisitorSwitcher() {
  const {
    visitors,
    activeVisitor,
    selectVisitor,
    addVisitor,
  } = useVisitor();

  return (
    <div className="visitor-switcher">
      <label
        htmlFor="visitor-select"
        className="field-label"
      >
        Visitor
      </label>

      <select
        id="visitor-select"
        value={activeVisitor.id}
        onChange={(event) => selectVisitor(event.target.value)}
        className="visitor-switcher__select"
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
        className="button button--primary visitor-switcher__add"
      >
        + Add visitor
      </button>
    </div>
  );
}
