import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CategoriesPanel } from './CategoriesPanel';
import { installFetchMock, jsonResponse } from '../test/mockFetch';
import { renderWithProviders as render } from '../test/renderWithProviders';

const FIXTURE = {
  categories: [
    { name: 'Salary', emoji: '💼', color: '#5CC773', catGroup: 'income', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Groceries', emoji: '🛒', color: '#F59942', catGroup: 'essential', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Rent', emoji: '🏠', color: '#5C9EF5', catGroup: 'fixed', sortOrder: 100, isBuiltin: true, createdAt: '2025-01-01' },
    { name: 'Coffee', emoji: '☕', color: '#A880ED', catGroup: 'variable', sortOrder: 500, isBuiltin: false, createdAt: '2025-02-02' },
    { name: 'Other', emoji: '▫️', color: '#999EB8', catGroup: 'variable', sortOrder: 999, isBuiltin: true, createdAt: '2025-01-01' },
  ],
};

describe('CategoriesPanel — load & render', () => {
  it('fetches /categories on mount and renders all groups in order', async () => {
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    expect(await screen.findByText('Income')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Income', 'Essentials', 'Fixed expenses', 'Variable expenses',
    ]);
  });

  it('places each category under its group section', async () => {
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    const incomeHead = await screen.findByRole('heading', { level: 3, name: 'Income' });
    const incomeSection = incomeHead.closest('section')!;
    expect(within(incomeSection).getByText('Salary')).toBeInTheDocument();
    expect(within(incomeSection).queryByText('Coffee')).not.toBeInTheDocument();
  });

  it('renders each tile with the category emoji', async () => {
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    expect(await screen.findByText('🛒')).toBeInTheDocument();
    expect(screen.getByText('☕')).toBeInTheDocument();
  });

  it('renders an "Add category" button', async () => {
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    expect(await screen.findByRole('button', { name: /add category/i })).toBeInTheDocument();
  });
});

describe('CategoriesPanel — delete affordances', () => {
  it('shows a remove button on every tile except "Other"', async () => {
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    expect(await screen.findByRole('button', { name: /remove coffee/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove salary/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove other/i })).not.toBeInTheDocument();
  });
});

describe('CategoriesPanel — delete flow', () => {
  it('clicking × opens a confirmation dialog naming the category', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /remove coffee/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /coffee/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^remove$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  it('cancel closes the dialog without calling the network', async () => {
    const user = userEvent.setup();
    const get = vi.fn(() => FIXTURE);
    installFetchMock({ 'GET /api/categories': get });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /remove coffee/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1); // only the initial load
  });

  it('confirming triggers DELETE and re-fetches the list', async () => {
    const user = userEvent.setup();
    const del = vi.fn(() => ({ ok: true, transactionsMoved: 0 }));
    const get = vi.fn(() => FIXTURE);
    installFetchMock({
      'GET /api/categories': get,
      'DELETE /api/categories/Coffee': del,
    });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /remove coffee/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the server error and keeps dialog open on a failed DELETE', async () => {
    const user = userEvent.setup();
    installFetchMock({
      'GET /api/categories': () => FIXTURE,
      'DELETE /api/categories/Coffee': () => jsonResponse(409, { error: 'in use' }),
    });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /remove coffee/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^remove$/i }));
    expect(await screen.findByText(/in use/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('CategoriesPanel — add flow', () => {
  it('clicking "Add category" opens an editable form with an empty name', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('');
    expect(nameInput).not.toBeDisabled();
  });

  it('saving a new category POSTs to /categories and re-fetches', async () => {
    const user = userEvent.setup();
    const post = vi.fn((body) => ({
      category: { ...(body as object), sortOrder: 500, isBuiltin: false, createdAt: 'now' },
    }));
    const get = vi.fn(() => FIXTURE);
    installFetchMock({
      'GET /api/categories': get,
      'POST /api/categories': post,
    });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Pets');
    await user.click(within(dialog).getByRole('radio', { name: /variable/i }));
    await user.click(within(dialog).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({
      name: 'Pets',
      catGroup: 'variable',
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a validation error when name is blank', async () => {
    const user = userEvent.setup();
    const post = vi.fn();
    installFetchMock({
      'GET /api/categories': () => FIXTURE,
      'POST /api/categories': post,
    });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^add$/i }));
    expect(await screen.findByText(/name the category/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('CategoriesPanel — edit flow', () => {
  it('clicking a tile opens an edit form pre-filled with the category', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click((await screen.findByText('Coffee')).closest('.cat-tile')!);
    const dialog = screen.getByRole('dialog');
    const nameInput = within(dialog).getByLabelText(/name/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Coffee');
    expect(nameInput).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /variable/i })).toBeChecked();
  });

  it('saving an edit PUTs to /categories/:name and re-fetches', async () => {
    const user = userEvent.setup();
    const put = vi.fn((body) => ({ category: { name: 'Coffee', ...(body as object) } }));
    const get = vi.fn(() => FIXTURE);
    installFetchMock({
      'GET /api/categories': get,
      'PUT /api/categories/Coffee': put,
    });
    render(<CategoriesPanel />);
    await user.click((await screen.findByText('Coffee')).closest('.cat-tile')!);
    await user.click(within(screen.getByRole('dialog')).getByRole('radio', { name: /fixed/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toMatchObject({ catGroup: 'fixed' });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('clicking × on a tile does NOT open the edit form', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /remove coffee/i }));
    // The visible dialog should be the delete confirmation, not an edit form.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^remove$/i })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/name/i)).not.toBeInTheDocument();
  });
});

describe('CategoriesPanel — emoji + colour pickers', () => {
  it('renders a grid of emoji choices in the add modal', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const dialog = screen.getByRole('dialog');
    // A representative subset — the full catalog has dozens but these are
    // load-bearing for typical Hon categories.
    ['🛒', '🍽️', '🏠', '💰', '🎭'].forEach((e) =>
      expect(within(dialog).getByRole('button', { name: e })).toBeInTheDocument(),
    );
  });

  it('renders a grid of colour swatches in the add modal', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const swatches = screen.getAllByRole('button', { name: /^#[0-9A-F]{6}$/i });
    expect(swatches.length).toBeGreaterThanOrEqual(20);
  });

  it('clicking an emoji marks it selected', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const dialog = screen.getByRole('dialog');
    const target = within(dialog).getByRole('button', { name: '🎯' });
    await user.click(target);
    expect(target).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking a colour marks it selected', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const swatch = screen.getByRole('button', { name: '#A880ED' });
    await user.click(swatch);
    expect(swatch).toHaveAttribute('aria-pressed', 'true');
  });

  it('save POSTs the user-picked emoji and colour, not the defaults', async () => {
    const user = userEvent.setup();
    const post = vi.fn((body) => ({ category: { ...(body as object), sortOrder: 500, isBuiltin: false, createdAt: 'now' } }));
    installFetchMock({
      'GET /api/categories': () => FIXTURE,
      'POST /api/categories': post,
    });
    render(<CategoriesPanel />);
    await user.click(await screen.findByRole('button', { name: /add category/i }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/name/i), 'Custom');
    await user.click(within(dialog).getByRole('button', { name: '🎯' }));
    await user.click(within(dialog).getByRole('button', { name: '#A880ED' }));
    await user.click(within(dialog).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toMatchObject({
      name: 'Custom', emoji: '🎯', color: '#A880ED',
    });
  });

  it('edit mode pre-selects the existing emoji and colour', async () => {
    const user = userEvent.setup();
    installFetchMock({ 'GET /api/categories': () => FIXTURE });
    render(<CategoriesPanel />);
    // Coffee has emoji ☕ and colour #A880ED in the fixture.
    await user.click((await screen.findByText('Coffee')).closest('.cat-tile')!);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '☕' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: '#A880ED' })).toHaveAttribute('aria-pressed', 'true');
  });
});
