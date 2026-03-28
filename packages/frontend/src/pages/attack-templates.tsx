import { createAttackTemplateRequestSchema } from '@hashhive/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { type Resolver, useForm } from 'react-hook-form';
import { z } from 'zod';
import { PermissionGuard } from '../components/features/permission-guard';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ErrorBanner } from '../components/ui/error-banner';
import { Input } from '../components/ui/input';
import { PageHeader } from '../components/ui/page-header';
import { Select } from '../components/ui/select';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import {
  type AttackTemplate,
  useAttackTemplates,
  useCreateAttackTemplate,
  useDeleteAttackTemplate,
  useUpdateAttackTemplate,
} from '../hooks/use-attack-templates';
import { useMasklists, useRulelists, useWordlists } from '../hooks/use-resources';
import { ApiError } from '../lib/api';
import { Permission } from '../lib/permissions';
import { useUiStore } from '../stores/ui';

/**
 * Create-mode schema requires mode to be a positive integer (no default 0).
 * Edit-mode uses the same schema but pre-populates mode from the template.
 */
const createFormSchema = createAttackTemplateRequestSchema.extend({
  mode: z.number({ error: 'Mode is required' }).int().nonnegative('Mode must be 0 or greater'),
});

type TemplateFormData = z.infer<typeof createFormSchema>;

export function AttackTemplatesPage() {
  const { selectedProjectId } = useUiStore();
  const { data, isLoading } = useAttackTemplates();
  const createTemplate = useCreateAttackTemplate();
  const deleteTemplate = useDeleteAttackTemplate();
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<AttackTemplate | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const updateTemplate = useUpdateAttackTemplate(editingTemplate?.id ?? 0);

  const wordlistsQuery = useWordlists();
  const rulelistsQuery = useRulelists();
  const masklistsQuery = useMasklists();

  const form = useForm<TemplateFormData>({
    resolver: zodResolver(createFormSchema) as unknown as Resolver<TemplateFormData>,
    defaultValues: { name: '' },
  });

  // Build name lookup maps from loaded resources
  const wordlists = wordlistsQuery.data?.resources ?? [];
  const rulelists = rulelistsQuery.data?.resources ?? [];
  const masklists = masklistsQuery.data?.resources ?? [];

  const wordlistNames = useMemo(() => new Map(wordlists.map((w) => [w.id, w.name])), [wordlists]);
  const rulelistNames = useMemo(() => new Map(rulelists.map((r) => [r.id, r.name])), [rulelists]);
  const masklistNames = useMemo(() => new Map(masklists.map((m) => [m.id, m.name])), [masklists]);

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Attack Templates</PageHeader>
        <EmptyState message="Select a project to view attack templates." />
      </div>
    );
  }

  const openCreateForm = () => {
    setEditingTemplate(null);
    setFormError(null);
    form.reset({ name: '' });
    setShowForm(true);
  };

  const openEditForm = (template: AttackTemplate) => {
    setEditingTemplate(template);
    setFormError(null);
    form.reset({
      name: template.name,
      description: template.description,
      mode: template.mode,
      wordlistId: template.wordlistId,
      rulelistId: template.rulelistId,
      masklistId: template.masklistId,
      tags: template.tags,
    });
    setShowForm(true);
  };

  const handleSubmit = form.handleSubmit(async (formData) => {
    try {
      if (editingTemplate) {
        await updateTemplate.mutateAsync(formData);
      } else {
        await createTemplate.mutateAsync(formData);
      }
      setFormError(null);
      form.reset();
      setShowForm(false);
      setEditingTemplate(null);
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError(editingTemplate ? 'Failed to update template' : 'Failed to create template');
      }
    }
  });

  const handleDelete = (id: number) => {
    if (window.confirm('Delete this attack template?')) {
      deleteTemplate.mutate(id, {
        onError: (err) => {
          if (err instanceof ApiError) {
            setFormError(err.message);
          } else {
            setFormError('Failed to delete template');
          }
        },
        onSuccess: () => {
          setFormError(null);
        },
      });
    }
  };

  const resolveResourceName = (id: number | null, names: Map<number, string>) =>
    id ? (names.get(id) ?? `#${id}`) : '-';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader>Attack Templates</PageHeader>
        <PermissionGuard permission={Permission.TEMPLATE_MANAGE}>
          <Button size="sm" onClick={openCreateForm}>
            New Template
          </Button>
        </PermissionGuard>
      </div>

      {formError && <ErrorBanner message={formError} />}

      {/* Create / Edit Form - guarded by TEMPLATE_MANAGE permission */}
      {showForm && (
        <PermissionGuard permission={Permission.TEMPLATE_MANAGE}>
          <form
            onSubmit={handleSubmit}
            className="space-y-3 rounded-md border border-surface-0 bg-surface-0/30 p-4"
          >
            <h3 className="text-sm font-medium">
              {editingTemplate ? 'Edit Template' : 'New Template'}
            </h3>

            <div>
              <label htmlFor="tpl-name" className="text-xs font-medium text-muted-foreground">
                Name
              </label>
              <Input id="tpl-name" className="mt-1.5" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="mt-1 text-xs text-destructive">
                  {form.formState.errors.name.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="tpl-description"
                className="text-xs font-medium text-muted-foreground"
              >
                Description
              </label>
              <textarea
                id="tpl-description"
                rows={2}
                className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
                {...form.register('description')}
              />
            </div>

            <div>
              <label htmlFor="tpl-mode" className="text-xs font-medium text-muted-foreground">
                Hashcat Mode
              </label>
              <Input
                id="tpl-mode"
                type="number"
                className="mt-1.5"
                {...form.register('mode', { valueAsNumber: true })}
              />
              {form.formState.errors.mode && (
                <p className="mt-1 text-xs text-destructive">
                  {form.formState.errors.mode.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="tpl-wordlist" className="text-xs font-medium text-muted-foreground">
                  Wordlist
                </label>
                <Select
                  id="tpl-wordlist"
                  className="mt-1.5"
                  {...form.register('wordlistId', {
                    setValueAs: (v: string) => (v === '' ? null : Number(v)),
                  })}
                >
                  <option value="">None</option>
                  {wordlists.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="tpl-rulelist" className="text-xs font-medium text-muted-foreground">
                  Rulelist
                </label>
                <Select
                  id="tpl-rulelist"
                  className="mt-1.5"
                  {...form.register('rulelistId', {
                    setValueAs: (v: string) => (v === '' ? null : Number(v)),
                  })}
                >
                  <option value="">None</option>
                  {rulelists.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="tpl-masklist" className="text-xs font-medium text-muted-foreground">
                  Masklist
                </label>
                <Select
                  id="tpl-masklist"
                  className="mt-1.5"
                  {...form.register('masklistId', {
                    setValueAs: (v: string) => (v === '' ? null : Number(v)),
                  })}
                >
                  <option value="">None</option>
                  {masklists.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <label htmlFor="tpl-tags" className="text-xs font-medium text-muted-foreground">
                Tags (comma-separated)
              </label>
              <Input
                id="tpl-tags"
                className="mt-1.5"
                placeholder="e.g. preferred, fast, ntlm"
                {...form.register('tags', {
                  setValueAs: (v: string) =>
                    v
                      ? v
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean)
                      : [],
                })}
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={createTemplate.isPending || updateTemplate.isPending}
              >
                {editingTemplate ? 'Update' : 'Create'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowForm(false);
                  setEditingTemplate(null);
                  setFormError(null);
                  form.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </PermissionGuard>
      )}

      {/* Template List */}
      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading..." />
        ) : !data?.templates.length ? (
          <EmptyState message="No attack templates found." />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>Name</Th>
                <Th>Mode</Th>
                <Th>Wordlist</Th>
                <Th>Rulelist</Th>
                <Th>Masklist</Th>
                <Th>Tags</Th>
                <Th>Created</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.templates.map((template) => (
                <TableRow key={template.id}>
                  <Td className="text-sm font-medium text-foreground">{template.name}</Td>
                  <Td className="font-mono text-xs text-muted-foreground">{template.mode}</Td>
                  <Td className="text-xs text-muted-foreground">
                    {resolveResourceName(template.wordlistId, wordlistNames)}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {resolveResourceName(template.rulelistId, rulelistNames)}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {resolveResourceName(template.masklistId, masklistNames)}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {template.tags.length > 0 ? template.tags.join(', ') : '-'}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {new Date(template.createdAt).toLocaleDateString()}
                  </Td>
                  <Td>
                    <PermissionGuard permission={Permission.TEMPLATE_MANAGE}>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="text-xs text-primary hover:text-primary/80"
                          onClick={() => openEditForm(template)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-xs text-destructive hover:text-destructive/80"
                          onClick={() => handleDelete(template.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </PermissionGuard>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
