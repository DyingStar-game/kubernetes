'use strict';

/* DyingStar dev panel - the window's texts.
 *
 * The main process hands the page one table of texts, in the language of the panel, before any
 * script runs (see preload.js). This file offers t() to the other scripts and fills the static
 * markup: an element says which text it wants with
 *
 *   data-i18n="key"               its text
 *   data-i18n-html="key"          its markup (for the few texts with <code> or <strong> in them;
 *                                 they come from our own files, never from a log or the network)
 *   data-i18n-title="key"         its tooltip
 *   data-i18n-placeholder="key"   its placeholder
 *
 * A key with no text leaves the element as the page wrote it, and t() returns the key: a
 * missing translation is an odd word on screen, never a broken page. */

(() => {
  const source = (window.panel && window.panel.i18n) || { lang: 'en', strings: {} };
  const strings = source.strings || {};

  function t(key, vars) {
    const text = strings[key] !== undefined ? strings[key] : key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  }

  function has(key) {
    return strings[key] !== undefined;
  }

  function applyTo(root) {
    root.querySelectorAll('[data-i18n]').forEach((node) => {
      if (has(node.dataset.i18n)) node.textContent = t(node.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-html]').forEach((node) => {
      if (has(node.dataset.i18nHtml)) node.innerHTML = t(node.dataset.i18nHtml);
    });
    root.querySelectorAll('[data-i18n-title]').forEach((node) => {
      if (has(node.dataset.i18nTitle)) node.title = t(node.dataset.i18nTitle);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      if (has(node.dataset.i18nPlaceholder)) node.placeholder = t(node.dataset.i18nPlaceholder);
    });
  }

  document.documentElement.lang = source.lang || 'en';
  if (has('app.title')) document.title = t('app.title');
  applyTo(document);

  window.t = t;
  window.i18n = { lang: source.lang || 'en', has, applyTo };
})();
