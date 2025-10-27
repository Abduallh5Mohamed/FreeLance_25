/* eslint-disable @typescript-eslint/no-explicit-any */
// Lightweight compatibility stub for `@supabase/supabase-js` usage.
//
// Purpose: the project has been migrated to a MySQL-backed API. Many files
// still import `supabase` from this path. To avoid Vite failing on
// unresolved `@supabase/supabase-js` during development we export a small
// shim that implements the most-used surface area (auth and from()).
//
// This shim intentionally returns safe defaults (empty arrays / nulls)
// and delegates to `src/lib/api.ts` for auth operations when possible.
// It's a temporary compatibility layer — replace file-level imports with the
// new API (`src/lib/api.ts`) as the full migration proceeds.

// NOTE: Do NOT import `@supabase/supabase-js` here. That package has been
// removed from `package.json` and importing it will break Vite.

type SupabaseResponse<T> = Promise<{ data: T; error: any } | { data: { user: any } | null; error: any }>;

const noop = async (..._args: any[]) => ({ data: null, error: null });

export const supabase = {
  auth: {
    // Tries to read a stored user from localStorage (if any) to mimic
    // `supabase.auth.getUser()` shape: { data: { user }, error }
    async getUser(): Promise<{ data: { user: any } | null; error: any }> {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('supabaseUser') : null;
        const user = raw ? JSON.parse(raw) : null;
        return { data: { user }, error: null };
      } catch (err) {
        return { data: { user: null }, error: err };
      }
    },

    // Try delegating to the new API's signIn implementation if available.
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      try {
        // dynamic import to avoid circular/top-level dependency issues
        // and to keep this file import-free of `@supabase/supabase-js`.
        // If the new API is not yet wired, fallback to a helpful error.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const api = await import('../../lib/api');
        if (api && typeof api.signIn === 'function') {
          const result = await api.signIn(email, password);
          if (result && result.user) {
            try { localStorage.setItem('supabaseUser', JSON.stringify(result.user)); } catch (e) { /* ignore */ }
            return { data: { user: result.user }, error: null };
          }
          return { data: null, error: result.error || { message: 'Invalid credentials' } };
        }
      } catch (e) {
        // fallthrough
      }
      return { data: null, error: { message: 'Auth not yet implemented — please migrate to src/lib/api.ts' } };
    },

    async signUp({ email, password, options }: any) {
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const api = await import('../../lib/api');
        if (api && typeof api.signUp === 'function') {
          const result = await api.signUp(email, password, options?.data ?? {});
          if (result && result.user) {
            try { localStorage.setItem('supabaseUser', JSON.stringify(result.user)); } catch (e) { /* ignore */ }
            return { data: { user: result.user }, error: null };
          }
          return { data: null, error: result.error || { message: 'Signup failed' } };
        }
      } catch (e) {
        // fallthrough
      }
      return { data: null, error: { message: 'Signup not yet implemented — please migrate to src/lib/api.ts' } };
    },

    async signOut() {
      try { localStorage.removeItem('supabaseUser'); } catch (e) { /* ignore */ }
      return { error: null };
    }
  },

  // Minimal `from()` query builder shim. Methods return safe defaults so
  // existing code that destructures `{ data, error }` won't crash during
  // the migration. This does NOT implement a full query builder — it's a
  // stop-gap to let the app run while you replace calls with `src/lib/api`.
  from(tableName: string) {
    const builder: any = {
      _table: tableName,
      eq(_col: string, _val: any) { return this; },
      order(_col: string, _opts?: any) { return this; },
      limit(_n: number) { return this; },
      // select() commonly returns arrays for list queries. Provide an empty
      // array by default.
      async select(_cols?: any): Promise<{ data: any[]; error: any }> {
        return { data: [], error: null };
      },
      async single(): Promise<{ data: any; error: any }> { return { data: null, error: null }; },
      async maybeSingle(): Promise<{ data: any; error: any }> { return { data: null, error: null }; },
      async insert(payload: any): Promise<{ data: any; error: any }> { return { data: payload, error: null }; },
      async update(payload: any): Promise<{ data: any; error: any }> { return { data: payload, error: null }; },
      async delete(): Promise<{ data: any; error: any }> { return { data: null, error: null }; }
    };
    return builder;
  }
};

export default supabase;