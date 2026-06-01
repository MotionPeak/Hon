// TanStack Query hooks for the Categories domain. Components call these instead
// of doing useEffect + api() + setState by hand:
//   - useCategories()     → { data, isLoading, error } for the list
//   - useCreateCategory() → mutation; on success it invalidates the list
//   - useUpdateCategory() / useDeleteCategory() likewise
// Query owns caching, dedupe and the loading/error flags; the mutations keep
// the cache fresh by invalidating qk.categories() so every subscriber (the
// settings panel, the activity category picker, …) updates together.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CategoryCreate, CategoryUpdate } from '@hon/shared/category';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../categories';
import { qk } from '../queryClient';

/** The category list. Replaces the old `refresh()` + useState in CategoriesPanel
 *  and every other tab that fetched `/categories` on mount. */
export function useCategories() {
  return useQuery({ queryKey: qk.categories(), queryFn: listCategories });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CategoryCreate) => createCategory(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: CategoryUpdate }) =>
      updateCategory(name, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}

export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteCategory(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.categories() }),
  });
}
