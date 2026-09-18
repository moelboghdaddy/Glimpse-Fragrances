/* Glimpse — shared cart logic.
   Cart state is stored in localStorage so it persists across pages
   (index.html, product.html, checkout.html) when the site is actually
   hosted or opened as real files. */
(function () {
  const CART_KEY = 'glimpse_cart';

  // Single source of truth for each product's current thumbnail image.
  // Cart/checkout look images up here by id instead of trusting whatever
  // path was saved to localStorage at add-to-cart time, so a later asset
  // rename never leaves old cart items pointing at a missing file.
  const PRODUCT_IMAGES = {
    'portofino': 'assets/Portofino no notes.png',
    'tropical-chill': 'assets/tc no notes.png',
    'cold-fire': 'assets/cold fire.png'
  };

  function getDisplayImage(item) {
    return PRODUCT_IMAGES[item.id] || item.image || 'assets/logo.png';
  }

  function getCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveCart(cart) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
    renderCart();
  }

  function addToCart(item) {
    const cart = getCart();
    const existing = cart.find(i => i.id === item.id);
    if (existing) {
      existing.qty += item.qty;
    } else {
      cart.push(item);
    }
    saveCart(cart);
  }

  function removeFromCart(id) {
    saveCart(getCart().filter(i => i.id !== id));
  }

  function setQty(id, qty) {
    const cart = getCart();
    const item = cart.find(i => i.id === id);
    if (item) item.qty = Math.max(1, qty);
    saveCart(cart);
  }

  function clearCart() {
    saveCart([]);
  }

  function formatPrice(n) {
    return n.toLocaleString('en-US') + ' EGP';
  }

  function getSubtotal() {
    return getCart().reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  function getCount() {
    return getCart().reduce((sum, i) => sum + i.qty, 0);
  }

  function renderCart() {
    const cart = getCart();
    const badge = document.getElementById('cart-badge');
    const itemsEl = document.getElementById('cart-items');
    const emptyEl = document.getElementById('cart-empty');
    const subtotalEl = document.getElementById('cart-subtotal-value');
    const checkoutBtn = document.getElementById('cart-checkout-btn');

    const count = getCount();
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }

    if (!itemsEl) return; // this page has no cart panel markup (shouldn't happen, but stay safe)

    if (cart.length === 0) {
      itemsEl.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
      if (checkoutBtn) checkoutBtn.classList.add('disabled');
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      if (checkoutBtn) checkoutBtn.classList.remove('disabled');
      itemsEl.innerHTML = cart.map(i => `
        <div class="cart-item" data-id="${i.id}">
          <img src="${getDisplayImage(i)}" alt="${i.name}" onerror="this.onerror=null; this.src='assets/logo.png';">
          <div class="cart-item-info">
            <div class="cart-item-name">${i.name}</div>
            <div class="cart-item-price">${formatPrice(i.price)}</div>
            <div class="cart-item-qty">
              <button class="cart-qty-btn" data-action="minus" data-id="${i.id}">–</button>
              <span>${i.qty}</span>
              <button class="cart-qty-btn" data-action="plus" data-id="${i.id}">+</button>
            </div>
          </div>
          <button class="cart-remove" data-id="${i.id}" aria-label="Remove item">×</button>
        </div>
      `).join('');
    }

    if (subtotalEl) subtotalEl.textContent = formatPrice(getSubtotal());

    // Let any page-specific script (e.g. checkout.html) know the cart changed
    document.dispatchEvent(new CustomEvent('cart:updated'));
  }

  // Event delegation for qty +/- and remove buttons inside the cart panel
  document.addEventListener('click', (e) => {
    const minus = e.target.closest('[data-action="minus"]');
    const plus = e.target.closest('[data-action="plus"]');
    const remove = e.target.closest('.cart-remove');
    if (minus) {
      const item = getCart().find(i => i.id === minus.dataset.id);
      if (item) { item.qty <= 1 ? removeFromCart(item.id) : setQty(item.id, item.qty - 1); }
    }
    if (plus) {
      const item = getCart().find(i => i.id === plus.dataset.id);
      if (item) setQty(item.id, item.qty + 1);
    }
    if (remove) removeFromCart(remove.dataset.id);
  });

  // Open / close the dropdown panel
  document.addEventListener('DOMContentLoaded', () => {
    renderCart();
    const toggle = document.getElementById('cart-toggle');
    const panel = document.getElementById('cart-panel');
    if (toggle && panel) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && !toggle.contains(e.target)) {
          panel.classList.remove('open');
        }
      });
    }
  });

  function generateOrderNumber() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'GL-' + ts + rand;
  }

  function flyToCart(imgSrc, startRect) {
    const cartBtn = document.getElementById('cart-toggle');
    if (!cartBtn) return;
    const endRect = cartBtn.getBoundingClientRect();

    const flyer = document.createElement('img');
    flyer.src = imgSrc;
    Object.assign(flyer.style, {
      position: 'fixed',
      left: startRect.left + 'px',
      top: startRect.top + 'px',
      width: startRect.width + 'px',
      height: startRect.height + 'px',
      objectFit: 'cover',
      borderRadius: '6px',
      zIndex: '9999',
      pointerEvents: 'none',
      transition: 'transform .7s cubic-bezier(.4,0,.2,1), opacity .7s ease'
    });
    document.body.appendChild(flyer);
    flyer.getBoundingClientRect(); // force reflow so the transition applies

    const dx = (endRect.left + endRect.width / 2) - (startRect.left + startRect.width / 2);
    const dy = (endRect.top + endRect.height / 2) - (startRect.top + startRect.height / 2);

    requestAnimationFrame(() => {
      flyer.style.transform = `translate(${dx}px, ${dy}px) scale(0.12)`;
      flyer.style.opacity = '0.2';
    });

    flyer.addEventListener('transitionend', () => {
      flyer.remove();
      cartBtn.classList.add('cart-bump');
      setTimeout(() => cartBtn.classList.remove('cart-bump'), 350);
    });
  }

  window.GlimpseCart = {
    getCart, saveCart, addToCart, removeFromCart, setQty, clearCart, getSubtotal, getCount, renderCart,
    formatPrice, generateOrderNumber, flyToCart, getDisplayImage
  };
})();
