import { useEffect, useState, useCallback, useRef } from "react";

export type AlertType = "error" | "info" | "warning";

export interface Alert {
  id: number;
  type: AlertType;
  message: string;
  detail?: string;
}

let nextId = 0;
let globalDispatch: ((alert: Omit<Alert, "id">) => void) | null = null;

export function showAlert(type: AlertType, message: string, detail?: string) {
  globalDispatch?.({ type, message, detail });
}

export function showError(message: string, detail?: string) {
  showAlert("error", message, detail);
}

export function showInfo(message: string) {
  showAlert("info", message);
}

export function showWarning(message: string) {
  showAlert("warning", message);
}

const STYLES: Record<AlertType, { bg: string; text: string; border: string }> =
  {
    error: { bg: "#F01111", text: "#ffffff", border: "#a80c0c" },
    info: { bg: "#117090", text: "#ffffff", border: "#0b4d64" },
    warning: { bg: "#F7F744", text: "#000000", border: "#adad30" },
  };

export default function AlertPanel() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const addAlert = useCallback((alert: Omit<Alert, "id">) => {
    const id = nextId++;
    setAlerts((prev) => [...prev, { ...alert, id }]);
  }, []);

  const removeAlert = useCallback((id: number) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  useEffect(() => {
    globalDispatch = addAlert;
    return () => {
      globalDispatch = null;
    };
  }, [addAlert]);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center pointer-events-none"
      style={{ paddingTop: "15vh", gap: "10px" }}
    >
      {alerts.map((alert) => (
        <AlertItem
          key={alert.id}
          alert={alert}
          onRemove={() => removeAlert(alert.id)}
        />
      ))}
    </div>
  );
}

function AlertItem({
  alert,
  onRemove,
}: {
  alert: Alert;
  onRemove: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const dismissingRef = useRef(false);

  // Trigger fade-in shortly after mount (works with both real and fake timers)
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(id);
  }, []);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    setFading(true);
    setTimeout(onRemove, 1000);
  }, [onRemove]);

  // Auto-dismiss: errors stay 8s, everything else 5s
  useEffect(() => {
    const delay = alert.type === "error" ? 8000 : 5000;
    const timer = setTimeout(dismiss, delay);
    return () => clearTimeout(timer);
  }, [alert.type, dismiss]);

  const colors = STYLES[alert.type];

  const opacity = fading ? 0 : visible ? 0.9 : 0;
  const transition = `opacity ${fading ? "1s" : "0.2s"} ease-${fading ? "out" : "in"}`;

  return (
    <div
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        boxShadow: "0 0 8px rgba(0,0,0,0.5)",
        padding: "26px",
        opacity,
        transition,
      }}
      className="pointer-events-auto rounded-lg max-w-xl w-[90%] sm:w-auto sm:min-w-[520px]"
    >
      <div className="flex items-start gap-4">
        <p className="flex-1 text-2xl font-medium">{alert.message}</p>
        <div className="flex items-center shrink-0">
          <button
            onClick={dismiss}
            className="ml-[20px] relative top-[2px] opacity-80 hover:opacity-100 transition-all duration-150 cursor-pointer leading-none
                       text-black hover:text-[#FFAF22] hover:[filter:drop-shadow(0_0_2px_rgba(255,175,34,0.9))]"
            aria-label="Dismiss"
          >
            <svg
              viewBox="0 0 384 512"
              width="20"
              height="20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
