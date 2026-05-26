import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api';

// Modals must escape .set-card's stacking context (.set-card has an animation
// that leaves an identity transform behind, which creates a containing block
// and breaks `position: fixed` on .overlay). Portalling to document.body
// matches what the old app.html does — its openModal() appends to <body>.
function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export interface Category {
  name: string;
  emoji: string;
  color: string;
  catGroup: 'income' | 'essential' | 'fixed' | 'variable';
  sortOrder: number;
  isBuiltin: boolean;
  createdAt: string;
}

const GROUP_ORDER: Category['catGroup'][] = ['income', 'essential', 'fixed', 'variable'];
const GROUP_LABEL: Record<Category['catGroup'], string> = {
  income: 'Income',
  essential: 'Essentials',
  fixed: 'Fixed expenses',
  variable: 'Variable expenses',
};

function sortCategories(cats: Category[]): Category[] {
  return [...cats].sort((a, b) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
}

function group(cats: Category[]): Record<Category['catGroup'], Category[]> {
  const out: Record<Category['catGroup'], Category[]> = {
    income: [], essential: [], fixed: [], variable: [],
  };
  sortCategories(cats).forEach((c) => out[c.catGroup].push(c));
  return out;
}

type EditorState =
  | { mode: 'add' }
  | { mode: 'edit'; category: Category };

const GROUP_DESCRIPTIONS: Array<[Category['catGroup'], string]> = [
  ['income', 'Inflow — counted as money in, never spending'],
  ['essential', 'Day-to-day, budgeted per category'],
  ['fixed', 'Recurring bill, tracked but not budgeted'],
  ['variable', 'Discretionary, pools into the variable allowance'],
];

const EMOJI_CHOICES = [
  '🛒', '🍽️', '🚌', '⛽', '🛍️', '💡', '🏠', '🛡️', '⚕️', '🎭', '🔁',
  '✈️', '📚', '💰', '↔️', '﹪', '▫️', '☕', '🍻', '🎮', '🎵', '💊',
  '🧾', '🏋️', '🐶', '🐱', '🎁', '💼', '🧰', '🚲', '🚗', '✂️', '💇',
  '💅', '📱', '💻', '🛏️', '🧺', '🪴', '🌱', '🧴', '🍼', '🎓', '🪙',
  '🪺', '📉', '📈', '🎯', '🪪',
];
const COLOR_CHOICES = [
  '#5CC773', '#F59942', '#5C9EF5', '#EB736B', '#D975D6', '#F2C752',
  '#66B8BD', '#6E8FD6', '#ED6680', '#A880ED', '#7D8CED', '#5CC7DB',
  '#73B39E', '#4CD180', '#B38C80', '#999EB8', '#8C8FA8', '#FF8AA1',
  '#B97AFF', '#6FD09C', '#FFD166',
];

export function CategoriesPanel() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ categories: Category[] }>('/categories');
      setCategories(d.categories);
    } catch {
      setCategories([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const cancelDelete = () => { setDeleting(null); setDeleteError(null); };
  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await api(`/categories/${encodeURIComponent(deleting.name)}`, 'DELETE');
      setDeleting(null);
      setDeleteError(null);
      await refresh();
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const grouped = group(categories);
  return (
    <div className="cat-panel">
      {GROUP_ORDER.map((g) => grouped[g].length === 0 ? null : (
        <section key={g} className="cat-section">
          <h3 className="cat-section-head">{GROUP_LABEL[g]}</h3>
          <div className="cat-grid">
            {grouped[g].map((c) => (
              <div
                key={c.name}
                className="cat-tile"
                style={{ '--cat-color': c.color } as React.CSSProperties}
                role="button"
                tabIndex={0}
                onClick={() => setEditor({ mode: 'edit', category: c })}
              >
                <div className="cat-tile-icon">{c.emoji}</div>
                <div className="cat-tile-name">{c.name}</div>
                {c.name !== 'Other' && (
                  <button
                    type="button"
                    className="cat-tile-del"
                    aria-label={`Remove ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleting(c);
                      setDeleteError(null);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      <button
        type="button"
        className="cat-add"
        onClick={() => setEditor({ mode: 'add' })}
      >
        <span className="cat-add-icon">+</span>
        <span className="cat-add-text">Add category</span>
      </button>
      {editor && (
        <CategoryEditor
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {deleting && !editor && (
        <ModalPortal>
        <div className="overlay">
        <div role="dialog" aria-label={`Remove ${deleting.name}`} className="modal">
          <h2>Remove &ldquo;{deleting.name}&rdquo;?</h2>
          <p>
            Any transactions tagged with <strong>{deleting.name}</strong> will move to Other.
            Merchant rules and the cached categorizer hits for this category will also reset.
          </p>
          {deleteError && <div className="modal-err">{deleteError}</div>}
          <div className="modal-actions">
            <button type="button" onClick={cancelDelete}>Cancel</button>
            <button type="button" className="danger" onClick={confirmDelete}>Remove</button>
          </div>
        </div>
        </div>
        </ModalPortal>
      )}
    </div>
  );
}

interface EditorProps {
  state: EditorState;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

function CategoryEditor({ state, onClose, onSaved }: EditorProps) {
  const isEdit = state.mode === 'edit';
  const cur = isEdit ? state.category : {
    name: '', emoji: '🏷️', color: '#8C8FA8',
    catGroup: 'variable' as Category['catGroup'],
  };
  const [name, setName] = useState(cur.name);
  const [group, setGroup] = useState<Category['catGroup']>(cur.catGroup);
  const [emoji, setEmoji] = useState(cur.emoji);
  const [color, setColor] = useState(cur.color);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!isEdit && !name.trim()) {
      setError('Name the category.');
      return;
    }
    try {
      if (isEdit) {
        await api(
          `/categories/${encodeURIComponent(state.category.name)}`,
          'PUT',
          { emoji, color, catGroup: group },
        );
      } else {
        await api('/categories', 'POST', {
          name: name.trim(),
          emoji,
          color,
          catGroup: group,
          sortOrder: 500,
        });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <ModalPortal>
    <div className="overlay">
    <div
      role="dialog"
      aria-label={isEdit ? `Edit ${cur.name}` : 'Add category'}
      className="modal"
    >
      <h2>{isEdit ? 'Edit category' : 'Add a category'}</h2>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          maxLength={40}
          disabled={isEdit}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <fieldset className="field">
        <legend>Icon</legend>
        <div className="ce-emoji-grid">
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              type="button"
              className={`ce-emoji${emoji === e ? ' on' : ''}`}
              aria-label={e}
              aria-pressed={emoji === e}
              onClick={() => setEmoji(e)}
            >
              {e}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Colour</legend>
        <div className="ce-color-grid">
          {COLOR_CHOICES.map((c) => (
            <button
              key={c}
              type="button"
              className={`ce-color${color === c ? ' on' : ''}`}
              style={{ background: c }}
              aria-label={c}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Group</legend>
        {GROUP_DESCRIPTIONS.map(([g, sub]) => (
          <label key={g} className={`ce-group${group === g ? ' on' : ''}`}>
            <input
              type="radio"
              name="ce-group"
              value={g}
              checked={group === g}
              onChange={() => setGroup(g)}
            />
            <span className="ce-group-name">
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </span>
            <span className="ce-group-sub">{sub}</span>
          </label>
        ))}
      </fieldset>
      {error && <div className="modal-err">{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" onClick={submit}>
          {isEdit ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
    </div>
    </ModalPortal>
  );
}
