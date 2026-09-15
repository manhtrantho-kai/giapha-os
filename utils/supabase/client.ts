import { createBrowserClient } from '@supabase/ssr'
import { SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY

export const createClient = () => {
  if (!supabaseUrl || !supabaseKey) {
    // Return a dummy client to avoid crashing the render if accessed before redirect
    return {
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
        signInWithPassword: async () => ({
          data: null,
          error: new Error('Missing Supabase configuration')
        }),
        signUp: async () => ({
          data: null,
          error: new Error('Missing Supabase configuration')
        })
      }
    } as unknown as SupabaseClient
  }
  return createBrowserClient(supabaseUrl, supabaseKey)
}
