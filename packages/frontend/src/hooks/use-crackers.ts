import type {
  CrackerCheckUpdateResponse,
  KnownEngineName,
  KnownPlatformName,
  SelectCrackerBinary,
} from '@hashhive/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Wire DTO for cracker binaries. Derived from `SelectCrackerBinary` so a
 * column added to the shared schema surfaces here as a type error before
 * it can drift, but with `Date` columns narrowed to ISO strings (HTTP
 * serialization).
 */
export type CrackerBinary = Omit<SelectCrackerBinary, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

/** Re-exports so admin pages import a single namespace. */
export type { CrackerCheckUpdateResponse, KnownEngineName, KnownPlatformName };

interface ListOptions {
  engine?: string;
  includeInactive?: boolean;
  enabled?: boolean;
}

interface MutationCallbacks {
  /**
   * Called on mutation failure with a user-presentable message. Hooks do
   * not implement their own toasts — the page owns presentation. Wire
   * this to an ErrorBanner / inline message.
   */
  onError?: (message: string) => void;
}

const QUERY_KEY = 'crackers' as const;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function useCrackerBinaries(options: ListOptions = {}) {
  const { engine, includeInactive = false, enabled = true } = options;

  return useQuery({
    queryKey: [QUERY_KEY, { engine, includeInactive }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (engine) params.set('engine', engine);
      if (includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      const path = qs ? `/dashboard/crackers?${qs}` : '/dashboard/crackers';
      const data = await api.get<{ crackerBinaries: CrackerBinary[] }>(path);
      return data.crackerBinaries;
    },
    enabled,
  });
}

export function useCrackerBinary(id: number, enabled = true) {
  return useQuery({
    queryKey: [QUERY_KEY, id],
    queryFn: async () => {
      const data = await api.get<{ crackerBinary: CrackerBinary }>(`/dashboard/crackers/${id}`);
      return data.crackerBinary;
    },
    enabled: enabled && Number.isFinite(id) && id > 0,
  });
}

interface CreateInput {
  engine: KnownEngineName;
  version: string;
  platform: KnownPlatformName;
}

export function useCreateCrackerBinary(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInput) => {
      const data = await api.post<{ crackerBinary: CrackerBinary }>('/dashboard/crackers', input);
      return data.crackerBinary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to create cracker binary'));
    },
  });
}

export function useUpdateCrackerBinary(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; isActive?: boolean }) => {
      const { id, ...patch } = input;
      const data = await api.patch<{ crackerBinary: CrackerBinary }>(
        `/dashboard/crackers/${id}`,
        patch
      );
      return data.crackerBinary;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to update cracker binary'));
    },
  });
}

export function useDeleteCrackerBinary(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete<{ acknowledged: true }>(`/dashboard/crackers/${id}`);
      return { id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to delete cracker binary'));
    },
  });
}

/**
 * Direct (single-request) upload of a cracker binary file. The backend
 * caps direct uploads at 100 MB; for larger binaries the chunked path
 * (`useUploadCrackerChunked`) drives the multipart endpoints instead.
 *
 * Failure recovery is the modal's responsibility: when this mutation
 * rejects, the caller MUST roll back the binary row (via
 * `useDeleteCrackerBinary`) so a retry doesn't hit a 409 from the
 * composite-uniqueness constraint.
 */
export function useUploadCrackerFile(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: number; file: File }) => {
      const fd = new FormData();
      fd.append('file', input.file);
      const res = await fetch(`/api/v1/dashboard/crackers/${input.id}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!res.ok) {
        let message = `Upload failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          // The server returned a non-JSON body — keep the status-coded
          // message. We deliberately do not log here: the upload error
          // surfaces through the mutation's onError callback, which is
          // where the user-visible error banner gets its text.
        }
        throw new Error(message);
      }
      return (await res.json()) as { key: string; size: number };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to upload cracker binary'));
    },
  });
}

interface ChunkedUploadInput {
  id: number;
  file: File;
  onProgress?: (progress: {
    uploadedBytes: number;
    totalBytes: number;
    partNumber: number;
    totalParts: number;
  }) => void;
  signal?: AbortSignal;
}

interface ChunkedInitResponse {
  uploadId: string;
  partSize: number;
  key: string;
}

interface ChunkedPartResponse {
  etag: string;
}

/**
 * Chunked upload for binaries above the direct-upload cap. Drives the
 * /upload/initiate, PUT part, and /complete endpoints in sequence. The
 * caller must roll back the binary row on failure (same contract as
 * `useUploadCrackerFile`).
 */
export function useUploadCrackerChunked(callbacks: MutationCallbacks = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChunkedUploadInput) => {
      const { id, file, onProgress, signal } = input;

      const init = await api.post<ChunkedInitResponse>('/dashboard/crackers/upload/initiate', {
        crackerBinaryId: id,
        fileSize: file.size,
        contentType: file.type || 'application/octet-stream',
        fileName: file.name,
      });

      const partSize = init.partSize;
      const totalParts = Math.max(1, Math.ceil(file.size / partSize));
      const parts: Array<{ partNumber: number; etag: string }> = [];

      try {
        for (let i = 0; i < totalParts; i++) {
          if (signal?.aborted) throw new Error('Upload aborted');
          const start = i * partSize;
          const end = Math.min(start + partSize, file.size);
          const chunk = file.slice(start, end);
          const partNumber = i + 1;

          const url = `/api/v1/dashboard/crackers/upload/${init.uploadId}/part/${partNumber}?crackerBinaryId=${id}`;
          const res = await fetch(url, {
            method: 'PUT',
            credentials: 'include',
            body: chunk,
            ...(signal ? { signal } : {}),
          });
          if (!res.ok) {
            let message = `Part ${partNumber} failed (${res.status})`;
            try {
              const body = (await res.json()) as { error?: { message?: string } };
              if (body?.error?.message) message = body.error.message;
            } catch {
              // ignore parse failure; we already have a status-coded message
            }
            throw new Error(message);
          }
          const partResult = (await res.json()) as ChunkedPartResponse;
          parts.push({ partNumber, etag: partResult.etag });

          onProgress?.({ uploadedBytes: end, totalBytes: file.size, partNumber, totalParts });
        }

        await api.post(`/dashboard/crackers/upload/${init.uploadId}/complete`, {
          crackerBinaryId: id,
          parts,
        });
      } catch (err) {
        // Best-effort abort so the in-progress upload is cleared.
        await api
          .delete(`/dashboard/crackers/upload/${init.uploadId}?crackerBinaryId=${id}`)
          .catch(() => {
            // Abort failed — backend will clear the DB pointer regardless.
          });
        throw err;
      }

      return { key: init.key, size: file.size };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      callbacks.onError?.(errorMessage(err, 'Failed to upload cracker binary'));
    },
  });
}
