(() => {
  const menu = document.getElementById('app-navigation');
  const toggle = document.getElementById('navigation-toggle');
  function closeMenu(returnFocus = false) {
    menu?.classList.remove('is-open');
    toggle?.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle?.focus();
  }
  toggle?.addEventListener('click', () => {
    const open = menu.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  menu?.addEventListener('click', event => {
    if (event.target.closest('.side-tab')) {
      closeMenu();
      document.querySelector('.page.active .page-title')?.focus();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.classList.contains('is-open')) closeMenu(true);
  });
  document.addEventListener('click', event => {
    if (menu?.classList.contains('is-open') && !menu.contains(event.target) && !toggle.contains(event.target)) closeMenu();
  });
  matchMedia('(min-width:921px)').addEventListener('change', () => closeMenu());

  function enhanceTables() {
    for (const [rowSelector, labels] of [
      ['.port-row', ['Symbol','Shares','CMP / Change','Value','P&L','XIRR']],
      ['.trades-row', ['Ticker','Type','Shares','Price','Amount','Date','Delete']]
    ]) {
      document.querySelectorAll(rowSelector).forEach(row => {
        Array.from(row.children).forEach((cell, index) => {
          if (labels[index]) cell.dataset.label = labels[index];
        });
        if (row.matches('.port-row') && !row.hasAttribute('tabindex')) {
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.setAttribute('aria-label', `View trade breakdown for ${row.querySelector('.ph-ticker')?.textContent || 'stock'}`);
          row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
          });
        }
      });
    }
    document.querySelectorAll('.page-title').forEach(title => title.tabIndex = -1);
    document.querySelectorAll('.sheet-table-wrap,.preview-table-wrap,.strategy-table,.cf-table,#settings-stocks-table,.table-box').forEach(wrapper => {
      if (wrapper.dataset.responsiveReady) return;
      wrapper.dataset.responsiveReady = 'true';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      const title = wrapper.closest('.page')?.querySelector('.page-title')?.textContent || 'Data';
      wrapper.setAttribute('aria-label', `${title} table. Scroll horizontally to see all columns.`);
      const hint = document.createElement('p');
      hint.className = 'scroll-hint';
      hint.textContent = 'Swipe or scroll sideways to see all columns.';
      wrapper.before(hint);
      wrapper.querySelectorAll('thead th').forEach(th => th.scope = 'col');
    });
  }
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; enhanceTables(); });
  });
  observer.observe(document.body, { childList:true, subtree:true });
  enhanceTables();
})();
