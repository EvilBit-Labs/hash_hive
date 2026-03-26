import { useCallback, useReducer, useRef } from 'react';
import { orchestrateUpload } from '../lib/chunked-upload/engine';
import { clearUploadState } from '../lib/chunked-upload/persistence';
import type { UploadProgress } from '../lib/chunked-upload/types';

type UploadStatus = 'idle' | 'uploading' | 'completed' | 'error';

interface UploadState {
  readonly status: UploadStatus;
  readonly progress: UploadProgress | null;
  readonly error: string | null;
}

type UploadAction =
  | { type: 'START' }
  | { type: 'PROGRESS'; progress: UploadProgress }
  | { type: 'COMPLETE' }
  | { type: 'ERROR'; error: string }
  | { type: 'RESET' };

const initialState: UploadState = {
  status: 'idle',
  progress: null,
  error: null,
};

function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case 'START':
      return { status: 'uploading', progress: null, error: null };
    case 'PROGRESS':
      return { ...state, progress: action.progress };
    case 'COMPLETE':
      return { ...state, status: 'completed' };
    case 'ERROR':
      return { ...state, status: 'error', error: action.error };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

interface UseChunkedUploadOptions {
  readonly onComplete?: (resourceId: number) => void;
  readonly onError?: (error: string) => void;
}

export function useChunkedUpload(options: UseChunkedUploadOptions = {}) {
  const [state, dispatch] = useReducer(uploadReducer, initialState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const start = useCallback(
    async (file: File, resourceType: string, name: string) => {
      // Abort any in-flight upload
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const gen = ++generationRef.current;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      uploadIdRef.current = `${resourceType}-${name}-${file.size}`;

      dispatch({ type: 'START' });

      try {
        const resourceId = await orchestrateUpload({
          file,
          resourceType,
          name,
          signal: controller.signal,
          onProgress: (progress) => {
            if (gen !== generationRef.current) return;
            dispatch({ type: 'PROGRESS', progress });
          },
        });

        if (gen !== generationRef.current) return;
        dispatch({ type: 'COMPLETE' });
        abortControllerRef.current = null;
        uploadIdRef.current = null;
        options.onComplete?.(resourceId);
      } catch (err) {
        if (gen !== generationRef.current) return;

        if (err instanceof DOMException && err.name === 'AbortError') {
          dispatch({ type: 'RESET' });
          return;
        }

        const message = err instanceof Error ? err.message : 'Upload failed';
        dispatch({ type: 'ERROR', error: message });
        uploadIdRef.current = null;
        options.onError?.(message);
      }
    },
    [options.onComplete, options.onError]
  );

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (uploadIdRef.current) {
      clearUploadState(uploadIdRef.current);
      uploadIdRef.current = null;
    }
    dispatch({ type: 'RESET' });
  }, []);

  return {
    state,
    start,
    cancel,
    isUploading: state.status === 'uploading',
    isComplete: state.status === 'completed',
    hasError: state.status === 'error',
  };
}
