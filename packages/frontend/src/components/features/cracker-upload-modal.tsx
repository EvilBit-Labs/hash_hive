import type { KnownEngineName, KnownPlatformName } from '@hashhive/shared';
import { KNOWN_ENGINES, KNOWN_PLATFORMS } from '@hashhive/shared';
import type { ChangeEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import {
  useCreateCrackerBinary,
  useDeleteCrackerBinary,
  useUploadCrackerChunked,
  useUploadCrackerFile,
} from '../../hooks/use-crackers';
import { Button } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { Input } from '../ui/input';

const ENGINE_LABELS: Record<KnownEngineName, string> = {
  hashcat: 'hashcat',
  john: 'John the Ripper',
};

const PLATFORM_LABELS: Record<KnownPlatformName, string> = {
  'linux-x64': 'Linux (x64)',
  'linux-arm64': 'Linux (arm64)',
  'windows-x64': 'Windows (x64)',
  'darwin-arm64': 'macOS (Apple Silicon)',
  'darwin-x64': 'macOS (Intel)',
};

const CHUNKED_UPLOAD_THRESHOLD = 100 * 1024 * 1024; // 100 MB — matches backend cap

interface CrackerUploadModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (crackerBinaryId: number) => void;
}

interface ProgressState {
  percentage: number;
  partNumber: number;
  totalParts: number;
}

export function CrackerUploadModal({ open, onClose, onSuccess }: CrackerUploadModalProps) {
  const [engine, setEngine] = useState<KnownEngineName>('hashcat');
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState<KnownPlatformName>('linux-x64');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const createBinary = useCreateCrackerBinary({ onError: setError });
  const directUpload = useUploadCrackerFile({ onError: setError });
  const chunkedUpload = useUploadCrackerChunked({ onError: setError });
  // Rollback on upload failure — no callback wiring needed since we only
  // call it from inside the catch path and the user already has an error
  // message from the failing upload mutation.
  const rollbackBinary = useDeleteCrackerBinary();

  const isUploading = createBinary.isPending || directUpload.isPending || chunkedUpload.isPending;
  const canSubmit = !!file && version.trim().length > 0 && !isUploading;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
    setProgress(null);
  };

  const handleReset = useCallback(() => {
    setEngine('hashcat');
    setVersion('');
    setPlatform('linux-x64');
    setFile(null);
    setError(null);
    setProgress(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleClose = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  const rollback = useCallback(
    async (crackerBinaryId: number) => {
      try {
        await rollbackBinary.mutateAsync(crackerBinaryId);
      } catch {
        // Rollback failed — leave the row for manual cleanup. The user
        // already saw the upload error; surfacing a second message here
        // would be noise.
      }
    },
    [rollbackBinary]
  );

  const handleSubmit = async () => {
    if (!file || !version.trim()) return;
    setError(null);
    setProgress(null);

    let createdId: number | null = null;
    try {
      const created = await createBinary.mutateAsync({
        engine,
        version: version.trim(),
        platform,
      });
      createdId = created.id;

      if (file.size > CHUNKED_UPLOAD_THRESHOLD) {
        const controller = new AbortController();
        abortRef.current = controller;
        await chunkedUpload.mutateAsync({
          id: created.id,
          file,
          signal: controller.signal,
          onProgress: ({ uploadedBytes, totalBytes, partNumber, totalParts }) => {
            setProgress({
              percentage: Math.round((uploadedBytes / totalBytes) * 100),
              partNumber,
              totalParts,
            });
          },
        });
        abortRef.current = null;
      } else {
        await directUpload.mutateAsync({ id: created.id, file });
      }

      onSuccess(created.id);
      handleReset();
      onClose();
    } catch (err) {
      // Roll back the binary row so the user can retry without hitting a
      // 409 from the (engine, version, platform) composite uniqueness
      // constraint. The error message has already been surfaced via the
      // mutation's onError callback.
      if (createdId !== null) {
        void rollback(createdId);
      }
      // err is already reflected in `error` via onError; nothing more to do.
      void err;
    }
  };

  if (!open) return null;

  const showProgress = progress !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crust/80">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cracker-upload-title"
        className="w-full max-w-md rounded-lg border border-surface-0 bg-mantle p-6 shadow-2xl"
      >
        <h3 id="cracker-upload-title" className="mb-4 text-sm font-medium">
          Upload Cracker Binary
        </h3>

        {error && <ErrorBanner message={error} className="mb-4" />}

        <div className="space-y-4">
          <div>
            <label htmlFor="cracker-engine" className="text-xs font-medium text-muted-foreground">
              Engine
            </label>
            <select
              id="cracker-engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value as KnownEngineName)}
              disabled={isUploading}
              className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-1.5 text-xs"
            >
              {KNOWN_ENGINES.map((value) => (
                <option key={value} value={value}>
                  {ENGINE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cracker-version" className="text-xs font-medium text-muted-foreground">
              Version
            </label>
            <Input
              id="cracker-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={isUploading}
              className="mt-1.5"
              placeholder="e.g. 6.2.6"
            />
          </div>

          <div>
            <label htmlFor="cracker-platform" className="text-xs font-medium text-muted-foreground">
              Platform
            </label>
            <select
              id="cracker-platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as KnownPlatformName)}
              disabled={isUploading}
              className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-1.5 text-xs"
            >
              {KNOWN_PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {PLATFORM_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="cracker-file" className="text-xs font-medium text-muted-foreground">
              File
            </label>
            <input
              id="cracker-file"
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              disabled={isUploading}
              className="mt-1.5 w-full text-xs text-muted-foreground file:mr-3 file:rounded file:border-0 file:bg-surface-0 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground disabled:opacity-50"
            />
          </div>

          {showProgress && (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded-full bg-surface-1">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progress.percentage}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {progress.percentage}% - Part {progress.partNumber} of {progress.totalParts}
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={isUploading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );
}
