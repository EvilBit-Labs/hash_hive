import type { ChangeEvent } from 'react';
import { useRef, useState } from 'react';
import { useCreateCrackerBinary, useUploadCrackerFile } from '../../hooks/use-crackers';
import { Button } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { Input } from '../ui/input';

const ENGINE_OPTIONS = [
  { value: 'hashcat', label: 'hashcat' },
  { value: 'john', label: 'John the Ripper' },
] as const;

const PLATFORM_OPTIONS = [
  { value: 'linux-x64', label: 'Linux (x64)' },
  { value: 'windows-x64', label: 'Windows (x64)' },
  { value: 'darwin-arm64', label: 'macOS (Apple Silicon)' },
  { value: 'darwin-x64', label: 'macOS (Intel)' },
] as const;

interface CrackerUploadModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (crackerBinaryId: number) => void;
}

export function CrackerUploadModal({ open, onClose, onSuccess }: CrackerUploadModalProps) {
  const [engine, setEngine] = useState<string>('hashcat');
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState<string>('linux-x64');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createBinary = useCreateCrackerBinary();
  const uploadFile = useUploadCrackerFile();

  const isUploading = createBinary.isPending || uploadFile.isPending;
  const canSubmit = !!file && version.trim().length > 0 && !isUploading;

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
  };

  const handleReset = () => {
    setEngine('hashcat');
    setVersion('');
    setPlatform('linux-x64');
    setFile(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleClose = () => {
    handleReset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!file || !version.trim()) return;
    setError(null);

    try {
      const created = await createBinary.mutateAsync({
        engine,
        version: version.trim(),
        platform,
      });
      await uploadFile.mutateAsync({ id: created.id, file });
      onSuccess(created.id);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  if (!open) return null;

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
              onChange={(e) => setEngine(e.target.value)}
              disabled={isUploading}
              className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-1.5 text-xs"
            >
              {ENGINE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
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
              onChange={(e) => setPlatform(e.target.value)}
              disabled={isUploading}
              className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-1.5 text-xs"
            >
              {PLATFORM_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
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
