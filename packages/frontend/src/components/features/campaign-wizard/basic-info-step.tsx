import type { UseFormReturn } from 'react-hook-form';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';

export interface BasicInfoForm {
  name: string;
  description?: string;
  priority: number;
  hashListId: number;
}

interface HashListOption {
  id: number;
  name: string;
  hashCount: number;
}

interface BasicInfoStepProps {
  form: UseFormReturn<BasicInfoForm>;
  hashLists: readonly HashListOption[];
  onSubmit: () => void;
  onUploadHashList: () => void;
  onCancel: () => void;
}

/**
 * Step 0 of the wizard. Collects name, description, priority, and the
 * hash list the campaign will run against. Validation is owned by the
 * parent's `basicInfoSchema`; this component only renders the form and
 * fires `onSubmit` when the user clicks Next.
 */
export function BasicInfoStep({
  form,
  hashLists,
  onSubmit,
  onUploadHashList,
  onCancel,
}: BasicInfoStepProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="name" className="text-xs font-medium text-muted-foreground">
          Campaign Name
        </label>
        <Input id="name" className="mt-1.5" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="mt-1 text-xs text-destructive">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div>
        <label htmlFor="description" className="text-xs font-medium text-muted-foreground">
          Description
        </label>
        <textarea
          id="description"
          rows={3}
          className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
          {...form.register('description')}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="priority" className="text-xs font-medium text-muted-foreground">
            Priority (1-10)
          </label>
          <Input
            id="priority"
            type="number"
            min={1}
            max={10}
            className="mt-1.5"
            {...form.register('priority')}
          />
        </div>
        <div>
          <label htmlFor="hashListId" className="text-xs font-medium text-muted-foreground">
            Hash List
          </label>
          <div className="mt-1.5 flex gap-2">
            <Select id="hashListId" {...form.register('hashListId')}>
              <option value="">Select a hash list...</option>
              {hashLists.map((hl) => (
                <option key={hl.id} value={hl.id}>
                  {hl.name} ({hl.hashCount} hashes)
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={onUploadHashList}>
              Upload
            </Button>
          </div>
          {form.formState.errors.hashListId && (
            <p className="mt-1 text-xs text-destructive">
              {form.formState.errors.hashListId.message}
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit">Next: Configure Attacks</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
