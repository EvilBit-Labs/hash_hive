import { useState } from 'react';
import { CrackerUploadModal } from '../components/features/cracker-upload-modal';
import { PermissionGuard } from '../components/features/permission-guard';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ErrorBanner } from '../components/ui/error-banner';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import {
  type CrackerBinary,
  useCrackerBinaries,
  useDeleteCrackerBinary,
  useUpdateCrackerBinary,
} from '../hooks/use-crackers';
import { Permission } from '../lib/permissions';

const ENGINES = ['', 'hashcat', 'john'] as const;
type EngineFilter = (typeof ENGINES)[number];

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export function CrackersPage() {
  return (
    <PermissionGuard
      permission={Permission.CRACKER_MANAGE}
      fallback={
        <div className="space-y-4">
          <PageHeader>Cracker Binaries</PageHeader>
          <EmptyState message="You do not have permission to manage cracker binaries." />
        </div>
      }
    >
      <CrackersAdminView />
    </PermissionGuard>
  );
}

function CrackersAdminView() {
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const queryArgs: Parameters<typeof useCrackerBinaries>[0] = { includeInactive };
  if (engineFilter) {
    queryArgs.engine = engineFilter;
  }
  const { data: binaries, isLoading, error, refetch } = useCrackerBinaries(queryArgs);
  const updateBinary = useUpdateCrackerBinary();
  const deleteBinary = useDeleteCrackerBinary();

  const handleToggleActive = async (binary: CrackerBinary) => {
    await updateBinary.mutateAsync({ id: binary.id, isActive: !binary.isActive });
  };

  const handleDelete = async (binary: CrackerBinary) => {
    const confirmed = window.confirm(
      `Delete ${binary.engine} ${binary.version} for ${binary.platform}? This removes the stored binary.`
    );
    if (!confirmed) return;
    await deleteBinary.mutateAsync(binary.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PageHeader>Cracker Binaries</PageHeader>
        <Button onClick={() => setUploadOpen(true)}>Upload Binary</Button>
      </div>

      {error && (
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Failed to load cracker binaries'}
        />
      )}

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          {ENGINES.map((value) => (
            <Button
              key={value || 'all'}
              variant={engineFilter === value ? 'primary' : 'secondary'}
              onClick={() => setEngineFilter(value)}
              className="text-xs"
            >
              {value || 'All engines'}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : !binaries || binaries.length === 0 ? (
        <EmptyState
          message="No cracker binaries registered yet."
          action={<Button onClick={() => setUploadOpen(true)}>Upload Binary</Button>}
        />
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <Th>Engine</Th>
              <Th>Version</Th>
              <Th>Platform</Th>
              <Th>Status</Th>
              <Th>Size</Th>
              <Th>Uploaded</Th>
              <Th>Actions</Th>
            </TableRow>
          </TableHead>
          <TableBody>
            {binaries.map((binary) => {
              const fileRef = binary.fileRef as { size?: number } | null;
              return (
                <TableRow key={binary.id}>
                  <Td>{binary.engine}</Td>
                  <Td>{binary.version}</Td>
                  <Td>{binary.platform}</Td>
                  <Td>{binary.isActive ? 'Active' : 'Inactive'}</Td>
                  <Td>{formatFileSize(fileRef?.size)}</Td>
                  <Td>{formatDate(binary.createdAt)}</Td>
                  <Td>
                    <div className="flex gap-1.5">
                      <Button
                        variant="secondary"
                        onClick={() => handleToggleActive(binary)}
                        disabled={updateBinary.isPending}
                        className="text-xs"
                      >
                        {binary.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleDelete(binary)}
                        disabled={deleteBinary.isPending}
                        className="text-xs"
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CrackerUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => {
          setUploadOpen(false);
          refetch();
        }}
      />
    </div>
  );
}
