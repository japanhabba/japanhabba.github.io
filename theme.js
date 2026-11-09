/*
  Dark mode toggle for japanhabba.org (styles live in theme.css).

  - First visit: follows the device's light/dark setting.
  - Clicking a [data-theme-toggle] button switches theme and remembers the choice.
  - The <head> of each page runs a tiny inline snippet that applies the saved theme
    before the page paints, so there's no white flash. This file wires up the buttons.
*/
(function () {
  var KEY = 'jh-theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function apply(isDark) {
    root.classList.toggle('dark', isDark);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#121017' : '#ffffff');
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(isDark));
      btn.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = isDark ? 'Light mode' : 'Dark mode';
    });
  }

  function toggle() {
    var isDark = !root.classList.contains('dark');
    // Briefly animate colours, then remove so normal hover transitions aren't affected
    root.classList.add('theme-transition');
    apply(isDark);
    setTimeout(function () { root.classList.remove('theme-transition'); }, 300);
    try { localStorage.setItem(KEY, isDark ? 'dark' : 'light'); } catch (e) {}
  }

  // Follow the device setting live, unless the visitor picked a theme themselves
  var onSystemChange = function (e) { if (!saved()) apply(e.matches); };
  if (media.addEventListener) media.addEventListener('change', onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange);

  function init() {
    apply(root.classList.contains('dark'));
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', toggle);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
