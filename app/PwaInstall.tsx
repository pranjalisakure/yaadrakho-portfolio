"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const dismissalKey = "yaadrakho-install-dismissed";
function wasDismissed() {
  try { return sessionStorage.getItem(dismissalKey) === "true"; } catch { return false; }
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function PwaInstall() {
  const pathname = usePathname();
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if ((window as typeof window & { YaadRakhoAndroid?: unknown }).YaadRakhoAndroid) {
      setDismissed(true);
      return;
    }
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
        .then((registration) => registration.update())
        .catch((error) => {
          console.error("YaadRakho service worker registration failed", error);
        });
    }
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    const iosDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);
    queueMicrotask(() => {
      setIsIos(iosDevice);
      setDismissed(isStandalone || wasDismissed());
    });
    const handlePrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
      setDismissed(isStandalone || wasDismissed());
    };
    window.addEventListener("beforeinstallprompt", handlePrompt);
    return () => window.removeEventListener("beforeinstallprompt", handlePrompt);
  }, []);

  async function install() {
    if (!promptEvent) {
      setShowInstallHelp(true);
      return;
    }
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === "accepted") setDismissed(true);
    setPromptEvent(null);
  }

  function dismiss() {
    setDismissed(true);
    try { sessionStorage.setItem(dismissalKey, "true"); } catch { /* Storage may be disabled. */ }
    setShowInstallHelp(false);
  }

  // Keep authentication and customer payment flows clear of promotional overlays.
  if (dismissed || pathname !== "/") return null;
  return (
    <aside className="install-banner" aria-label="Install YaadRakho app">
      <span className="install-icon">Y</span>
      <div><strong>Install YaadRakho</strong><small>{showInstallHelp ? (isIos ? "Tap Share, then Add to Home Screen." : "Open the browser menu, then choose Install app.") : "Open directly from your mobile home screen."}</small></div>
      <button className="install-action" onClick={install}>Install app</button>
      <button className="install-close" onClick={dismiss} aria-label="Dismiss install message">×</button>
    </aside>
  );
}
