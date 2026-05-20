import type { AttackTemplate } from '../../../hooks/use-attack-templates';
import { Button } from '../../ui/button';
import { ErrorBanner } from '../../ui/error-banner';

interface TemplatePickerOverlayProps {
  templates: readonly AttackTemplate[];
  isPending: boolean;
  error: string | null;
  onPick: (templateId: number) => void;
  onClose: () => void;
}

/**
 * Modal overlay for picking an attack template to seed the attack form
 * with. Stateless wrapper around the templates list — all data fetching
 * and template instantiation happens in the parent so error handling
 * stays in one place.
 */
export function TemplatePickerOverlay({
  templates,
  isPending,
  error,
  onPick,
  onClose,
}: TemplatePickerOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close template picker"
        className="absolute inset-0 bg-crust/80"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-picker-title"
        className="relative z-10 w-full max-w-md rounded-lg border border-surface-0 bg-mantle p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 id="template-picker-title" className="text-sm font-medium">
            Select a Template
          </h3>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
        {error && <ErrorBanner message={error} className="mb-2 text-xs" />}
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {templates.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No templates available.
            </p>
          ) : (
            templates.map((template) => (
              <div
                key={template.id}
                className="flex items-center justify-between rounded border border-surface-0 bg-surface-0/30 px-3 py-2"
              >
                <div className="text-xs">
                  <span className="font-medium">{template.name}</span>
                  <span className="ml-2 font-mono text-muted-foreground">Mode {template.mode}</span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => onPick(template.id)}
                >
                  Use
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
