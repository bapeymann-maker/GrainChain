// config.js
// Connection settings for the standalone Deliveries page (deliveries.html).
// Use the SAME values that are already in your live index.html.
//
// The project URL is filled in from your Supabase project. Paste the
// project's public "anon" key below (Supabase → Project Settings → API).
// If it's left as a placeholder the page shows a clear message instead of
// failing silently.

export const SUPABASE_URL = "https://ewzlxjimbxwurzbjzbxw.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV3emx4amltYnh3dXJ6Ymp6Ynh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDA4NDksImV4cCI6MjEwNTMxNjg0OX0.wJTPNqDP07_129K_90X-SOb4oji8ZENWi4S9L0xjGQk";

export function configProblem() {
  if (!SUPABASE_URL || /YOUR-|PASTE-/.test(SUPABASE_URL)) {
    return "The Supabase URL isn't set — edit src/config.js.";
  }
  if (!SUPABASE_ANON_KEY || /YOUR-|PASTE-/.test(SUPABASE_ANON_KEY)) {
    return "The Supabase anon key isn't set — edit src/config.js.";
  }
  return null;
}
