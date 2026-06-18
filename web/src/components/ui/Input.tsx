"use client";

import {
  forwardRef,
  useId,
  cloneElement,
  isValidElement,
  Children,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import { cn } from "./cn";

// Vantage form controls. Replaces hand-rolled input/textarea variants in auth/onboarding/extension
// and gives every text field the same focus-visible ring.
const FIELD =
  "w-full bg-white border border-border-dark text-ink text-[14px] font-body " +
  "rounded-[10px] px-3.5 py-[10px] placeholder:text-ink-muted " +
  "outline-none transition-colors hover:border-brown " +
  "focus:border-brown focus-visible:ring-2 focus-visible:ring-brown focus-visible:ring-offset-2 focus-visible:ring-offset-paper " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type, ...rest }, ref) {
    return <input ref={ref} type={type ?? "text"} className={cn(FIELD, className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(FIELD, "min-h-[88px] resize-y", className)} {...rest} />;
  },
);

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
}

// Field generates an explicit id for the inner Input + an id for the hint,
// then injects `id` + `aria-describedby` so screen readers announce the
// label and hint separately — fixing the implicit-label-eats-hint anti-pattern
// (`<label><span>Label</span><input/><span>hint</span></label>`) that screen readers
// flatten into one announcement.
export function Field({ label, children, hint }: FieldProps) {
  const inputId = useId();
  const hintId = useId();
  const child = Children.only(children);
  const enhanced = isValidElement(child)
    ? cloneElement(child as ReactElement<HTMLAttributes<HTMLElement>>, {
        id: inputId,
        "aria-describedby": hint ? hintId : undefined,
      })
    : child;
  return (
    <div className="block">
      <label
        htmlFor={inputId}
        className="mb-1.5 block font-body font-semibold text-[13px] text-ink"
      >
        {label}
      </label>
      {enhanced}
      {hint && (
        <span
          id={hintId}
          className="mt-1 block font-mono text-[11px] text-ink-muted"
        >
          {hint}
        </span>
      )}
    </div>
  );
}
