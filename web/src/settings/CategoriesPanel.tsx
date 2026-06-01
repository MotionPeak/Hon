import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  categoryFormSchema,
  type Category,
  type CategoryForm,
} from '@hon/shared/category';

// Re-export the shared Category type. It used to be declared locally in this
// file and ~10 modules import it from here; the canonical definition now lives
// in @hon/shared/category (single source of truth, shared with the engine), and
// this keeps those imports working. New code should import from @hon/shared.
export type { Category } from '@hon/shared/category';
import { ApiError } from '../api/client';
import {
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
} from '../api/hooks/useCategories';

// Modals must escape .set-card's stacking context (.set-card has an animation
// that leaves an identity transform behind, which creates a containing block
// and breaks `position: fixed` on .overlay). Portalling to document.body
// matches what the old app.html does — its openModal() appends to <body>.
function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
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
  // Server state via TanStack Query — no more useEffect + api() + setState.
  const { data: categories = [], isError } = useCategories();
  const deleteCategory = useDeleteCategory();

  const [deleting, setDeleting] = useState<Category | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const cancelDelete = () => { setDeleting(null); setDeleteError(null); };
  const confirmDelete = () => {
    if (!deleting) return;
    deleteCategory.mutate(deleting.name, {
      onSuccess: () => { setDeleting(null); setDeleteError(null); },
      onError: (e) => setDeleteError(e instanceof ApiError ? e.message : String(e)),
    });
  };

  // A fetch error renders as an empty grid (matching the old `catch → []`).
  const grouped = group(isError ? [] : categories);
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
          onSaved={() => setEditor(null)}
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
            <button
              type="button"
              className="danger"
              onClick={confirmDelete}
              disabled={deleteCategory.isPending}
            >
              {deleteCategory.isPending ? 'Removing…' : 'Remove'}
            </button>
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
  onSaved: () => void;
}

function CategoryEditor({ state, onClose, onSaved }: EditorProps) {
  const isEdit = state.mode === 'edit';
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();

  // react-hook-form + zod (the SHARED categoryFormSchema — the same schema the
  // engine validates the request against). Field errors come from the resolver;
  // the submit handler just fires the right TanStack mutation.
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CategoryForm>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: isEdit
      ? {
          name: state.category.name,
          emoji: state.category.emoji,
          color: state.category.color,
          catGroup: state.category.catGroup,
        }
      : { name: '', emoji: '🏷️', color: '#8C8FA8', catGroup: 'variable' },
  });

  // Register the three "picker" fields (emoji/colour/group) so RHF tracks them;
  // the visual buttons call setValue instead of native inputs.
  register('emoji');
  register('color');
  register('catGroup');
  const emoji = watch('emoji');
  const color = watch('color');
  const groupVal = watch('catGroup');

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit) {
        await updateCategory.mutateAsync({
          name: state.category.name,
          patch: { emoji: values.emoji, color: values.color, catGroup: values.catGroup },
        });
      } else {
        // sortOrder is owned by the API layer (new categories default to 500).
        await createCategory.mutateAsync({ ...values, sortOrder: 500 });
      }
      onSaved();
    } catch (e) {
      setError('root', { message: e instanceof ApiError ? e.message : String(e) });
    }
  });

  return (
    <ModalPortal>
    <div className="overlay">
    <form
      role="dialog"
      aria-label={isEdit ? `Edit ${state.category.name}` : 'Add category'}
      className="modal"
      onSubmit={onSubmit}
    >
      <h2>{isEdit ? 'Edit category' : 'Add a category'}</h2>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          maxLength={40}
          disabled={isEdit}
          {...register('name')}
        />
        {errors.name && <span className="field-err">{errors.name.message}</span>}
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
              onClick={() => setValue('emoji', e, { shouldValidate: true })}
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
              onClick={() => setValue('color', c, { shouldValidate: true })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Group</legend>
        {GROUP_DESCRIPTIONS.map(([g, sub]) => (
          <label key={g} className={`ce-group${groupVal === g ? ' on' : ''}`}>
            <input
              type="radio"
              name="ce-group"
              value={g}
              checked={groupVal === g}
              onChange={() => setValue('catGroup', g, { shouldValidate: true })}
            />
            <span className="ce-group-name">
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </span>
            <span className="ce-group-sub">{sub}</span>
          </label>
        ))}
      </fieldset>
      {errors.root && <div className="modal-err">{errors.root.message}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary" disabled={isSubmitting}>
          {isEdit ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
    </div>
    </ModalPortal>
  );
}
