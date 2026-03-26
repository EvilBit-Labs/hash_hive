import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { useCreateResource, useUploadResourceFile } from '../../hooks/use-resources';

type ResourceType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists';

const TYPE_LABELS: Record<ResourceType, string> = {
  'hash-lists': 'Hash List',
  wordlists: 'Wordlist',
  rulelists: 'Rulelist',
  masklists: 'Masklist',
};

interface ResourceUploadModalProps {
  type: ResourceType;
  open: boolean;
  onClose: () => void;
  onSuccess: (resourceId: number) => void;
}

export function ResourceUploadModal({ type, open, onClose, onSuccess }: ResourceUploadModalProps) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createResource = useCreateResource(type);
  const uploadFile = useUploadResourceFile(type);

  const isUploading = createResource.isPending || uploadFile.isPending;
  const label = TYPE_LABELS[type];

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (selected && !name) {
      setName(selected.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleUpload = async () => {
    if (!file || !name.trim()) return;

    setError(null);
    try {
      const result = await createResource.mutateAsync({ name: name.trim() });
      const resourceId = result.item.id;

      await uploadFile.mutateAsync({ id: resourceId, file });

      onSuccess(resourceId);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const handleClose = () => {
    setName('');
    setFile(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crust/80">
      <div className="w-full max-w-md rounded-lg border border-surface-0 bg-mantle p-6 shadow-2xl">
        <h3 className="mb-4 text-sm font-medium">Upload New {label}</h3>

        {error && (
          <div className="mb-4 rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label htmlFor="resource-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              id="resource-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
              placeholder={`Enter ${label.toLowerCase()} name`}
            />
          </div>

          <div>
            <label htmlFor="resource-file" className="text-xs font-medium text-muted-foreground">
              File
            </label>
            <input
              id="resource-file"
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              className="mt-1.5 w-full text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-surface-0 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={isUploading}
            className="rounded border border-surface-0 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || !name.trim() || isUploading}
            className="rounded bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {isUploading ? 'Uploading\u2026' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
