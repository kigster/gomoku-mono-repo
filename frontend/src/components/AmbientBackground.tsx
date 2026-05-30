import { useEffect, useRef } from "react";

type VantaInstance = { destroy?: () => void };
type VantaWindow = Window & {
  VANTA?: { NET?: (options: Record<string, unknown>) => VantaInstance };
  THREE?: unknown;
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(
      `script[src="${src}"]`,
    ) as HTMLScriptElement | null;
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve();
        return;
      }
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${src}`)),
        { once: true },
      );
      return;
    }

    const scriptElement = document.createElement("script");
    scriptElement.src = src;
    scriptElement.async = true;
    scriptElement.dataset.loaded = "false";
    scriptElement.addEventListener(
      "load",
      () => {
        scriptElement.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    scriptElement.addEventListener(
      "error",
      () => reject(new Error(`Failed to load ${src}`)),
      { once: true },
    );
    document.head.appendChild(scriptElement);
  });
}

export default function AmbientBackground() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let vantaInstance: VantaInstance | null = null;

    const initializeBackground = async () => {
      try {
        await loadScript(
          "https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js",
        );
        await loadScript(
          "https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.net.min.js",
        );

        if (cancelled || !containerRef.current) return;

        const globalWindow = window as VantaWindow;
        if (!globalWindow.VANTA?.NET) return;

        vantaInstance = globalWindow.VANTA.NET({
          el: containerRef.current,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200,
          minWidth: 200,
          scale: 1,
          scaleMobile: 1,
          color: 0xff833f,
          backgroundColor: 0x0,
        });
      } catch {
        // Quiet fallback to the static CSS background if the scripts fail.
      }
    };

    initializeBackground();

    return () => {
      cancelled = true;
      vantaInstance?.destroy?.();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 -z-10"
      aria-hidden="true"
    />
  );
}
