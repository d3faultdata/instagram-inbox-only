const INBOX_URL = "https://www.instagram.com/direct/inbox/";
const INBOX_PATH_PREFIX = "/direct/inbox";

function isInboxPath(path) {
  return path.startsWith(INBOX_PATH_PREFIX);
}

function redirectToInboxIfNeeded() {
  const path = location.pathname;
  if (!isInboxPath(path)) {
    // Simple behaviour, same as your original
    location.href = INBOX_URL;
  }
}

function lockUi() {
  const nav = document.querySelector('nav[role="navigation"]');
  if (nav) {
    nav.style.display = "none";
  }

  const links = document.querySelectorAll("a[href]");

  links.forEach((a) => {
    if (a.dataset.inboxFocusLocked === "1") return;

    const href = a.getAttribute("href");
    if (!href) return;

    if (href.startsWith("/direct")) return;
    if (href.startsWith(INBOX_URL)) return;

    a.dataset.inboxFocusLocked = "1";
    a.removeAttribute("href");
    a.style.pointerEvents = "none";
    a.style.opacity = "0.3";
  });
}

const observer = new MutationObserver(() => {
  lockUi();
});

function init() {
  redirectToInboxIfNeeded();

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    lockUi();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      observer.observe(document.body, { childList: true, subtree: true });
      lockUi();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
