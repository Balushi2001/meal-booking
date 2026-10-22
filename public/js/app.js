(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = (b) => (b / 1000).toFixed(3);
  const mealsWord = (n) => (n === 1 ? 'وجبة واحدة' : n === 2 ? 'وجبتان' : `${n} وجبات`);

  // Countdown to booking cutoff.
  function renderCountdown(el) {
    const left = Number(el.dataset.countdown) - Date.now();
    if (left <= 0) {
      el.textContent = 'أُغلق الحجز';
      if (!el.dataset.reloaded) { el.dataset.reloaded = '1'; setTimeout(() => location.reload(), 1500); }
      return;
    }
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    el.textContent = h ? `بعد ${h} ساعة و${m} دقيقة` : `بعد ${Math.max(m, 1)} دقيقة`;
  }
  const countdowns = $$('[data-countdown]');
  countdowns.forEach(renderCountdown);
  if (countdowns.length) setInterval(() => countdowns.forEach(renderCountdown), 20000);

  // Menu: one item per meal type, live total.
  const picker = $('[data-meal-picker]');
  if (picker) {
    const boxes = $$('input[name="meal"]', picker);
    const update = () => {
      const chosen = boxes.filter((b) => b.checked);
      const total = chosen.reduce((s, b) => s + Number(b.dataset.price), 0);
      $('[data-total]', picker).textContent = chosen.length ? `${mealsWord(chosen.length)} · ${money(total)} ر.ع` : 'اختر وجباتك';
      $('[data-next]', picker).disabled = !chosen.length;
    };
    boxes.forEach((b) => b.addEventListener('change', () => {
      if (b.checked) boxes.filter((o) => o !== b && o.dataset.type === b.dataset.type).forEach((o) => { o.checked = false; });
      update();
    }));
    update();
  }

  // Copy to clipboard.
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(btn.dataset.copy); btn.textContent = 'تم النسخ ✓'; } catch { btn.textContent = btn.dataset.copy; }
  }));

  // Confirm before submitting.
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  }));

  // Auto-submit selects/date pickers.
  $$('[data-autosubmit]').forEach((el) => {
    const initial = el.value;
    el.addEventListener('change', () => {
      if (el.dataset.confirmChange && !confirm(el.dataset.confirmChange)) { el.value = initial; return; }
      el.form.submit();
    });
  });

  // Sidebar toggle on small screens.
  $$('[data-toggle]').forEach((btn) => btn.addEventListener('click', () => $(btn.dataset.toggle).classList.toggle('open')));

  // Kiosk keypad: one letter first, then digits.
  const keypad = $('[data-keypad]');
  if (keypad) {
    const display = $('.k-display', keypad);
    const letters = $('[data-letters]', keypad);
    const sync = () => {
      const needLetter = display.value.length === 0;
      letters.classList.toggle('hidden', !needLetter);
      $$('.k-pad [data-key]', keypad).forEach((b) => { b.disabled = needLetter || display.value.length >= 5; });
      $('.k-go', keypad).disabled = display.value.length < 4;
    };
    const press = (k) => {
      k = k.toUpperCase();
      if (display.value.length === 0 ? /^[A-Z]$/.test(k) : /^\d$/.test(k) && display.value.length < 5) display.value += k;
      sync();
    };
    $$('[data-key]', keypad).forEach((b) => b.addEventListener('click', () => press(b.dataset.key)));
    $('[data-clear]', keypad).addEventListener('click', () => { display.value = ''; sync(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') { display.value = display.value.slice(0, -1); sync(); }
      else if (e.key === 'Enter') { if (display.value.length >= 4) keypad.submit(); }
      else if (e.key.length === 1) press(e.key);
    });
    sync();
  }

  // Kiosk result screens return to start.
  const reset = $('[data-auto-reset]');
  if (reset) {
    let left = Number(reset.dataset.autoReset);
    const note = $('[data-reset-note]');
    const timer = setInterval(() => {
      left -= 1;
      if (note) note.textContent = `تعود الشاشة للبداية بعد ${left} ثوانٍ`;
      if (left <= 0) { clearInterval(timer); location.href = '/kiosk'; }
    }, 1000);
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
