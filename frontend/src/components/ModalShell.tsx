import { createPortal } from "react-dom";
import { useEffect, type ReactNode } from "react";
import ModalCloseButton from "./ModalCloseButton";

interface ModalShellProps {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  bodyClassName?: string;
  titleClassName?: string;
}

export default function ModalShell({
  title,
  onClose,
  children,
  footer,
  widthClassName = "max-w-5xl",
  bodyClassName = "",
  titleClassName = "",
}: ModalShellProps) {
  useEffect(() => {
    if (!onClose) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100000] flex items-center justify-center p-3 sm:p-5">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        className={`relative z-10 flex w-full ${widthClassName} max-h-[88vh] flex-col overflow-hidden
                    rounded-[1.6rem] border border-neutral-700 bg-neutral-800 shadow-2xl shadow-black/60`}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between gap-4 border-b border-neutral-700 px-6 py-5 sm:px-8">
          <h2
            className={`font-heading text-2xl font-bold text-white ${titleClassName}`}
          >
            {title}
          </h2>
          {onClose && <ModalCloseButton onClick={onClose} />}
        </div>

        <div
          className={`min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8 ${bodyClassName}`}
        >
          {children}
        </div>

        {footer && (
          <div className="border-t border-neutral-700 px-6 py-4 sm:px-8">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
