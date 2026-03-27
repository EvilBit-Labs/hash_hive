import type { ChangeEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import { useChunkedUpload } from '../../hooks/use-chunked-upload';
import { useCreateResource, useUploadResourceFile } from '../../hooks/use-resources';
import { Button } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { Input } from '../ui/input';

type ResourceType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists';

const TYPE_LABELS: Record<ResourceType, string> = {
  'hash-lists': 'Hash List',
  wordlists: 'Wordlist',
  rulelists: 'Rulelist',
  masklists: 'Masklist',
};

const CHUNKED_UPLOAD_THRESHOLD = 100 * 1024 * 1024; // 100 MB

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

  const handleChunkedComplete = useCallback(
    (resourceId: number) => {
      onSuccess(resourceId);
      setName('');
      setFile(null);
      setError(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      onClose();
    },
    [onSuccess, onClose]
  );

  const handleChunkedError = useCallback((errorMessage: string) => {
    setError(errorMessage);
  }, []);

  const chunkedUpload = useChunkedUpload({
    onComplete: handleChunkedComplete,
    onError: handleChunkedError,
  });

  const isSmallUpload = createResource.isPending || uploadFile.isPending;
  const isUploading = isSmallUpload || chunkedUpload.isUploading;
  const label = TYPE_LABELS[type];
  const useChunkedPath = file !== null && file.size > CHUNKED_UPLOAD_THRESHOLD;

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

    if (useChunkedPath) {
      await chunkedUpload.start(file, type, name.trim());
      return;
    }

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

  const handleReset = () => {
    setName('');
    setFile(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = () => {
    if (chunkedUpload.isUploading) {
      chunkedUpload.cancel();
    }
    handleReset();
    onClose();
  };

  if (!open) return null;

  const chunkedProgress = chunkedUpload.state.progress;
  const displayProgress = chunkedProgress ? chunkedProgress.percentage : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crust/80">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-upload-title"
        className="w-full max-w-md rounded-lg border border-surface-0 bg-mantle p-6 shadow-2xl"
      >
        <h3 id="resource-upload-title" className="mb-4 text-sm font-medium">
          Upload New {label}
        </h3>

        {error && <ErrorBanner message={error} className="mb-4" />}

        <div className="space-y-4">
          <div>
            <label htmlFor="resource-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              id="resource-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isUploading}
              className="mt-1.5"
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
              disabled={isUploading}
              className="mt-1.5 w-full text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-surface-0 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground disabled:opacity-50"
            />
          </div>

          {displayProgress !== null && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-surface-1">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${displayProgress}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {displayProgress}%
                {chunkedProgress && (
                  <span>
                    {' '}
                    - Part {chunkedProgress.currentPart} of {chunkedProgress.totalParts}
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={isSmallUpload}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || !name.trim() || isUploading}>
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );
}
