# HashHive Product Overview

HashHive is a distributed password cracking platform that orchestrates hashcat across multiple agents in a LAN environment. It manages campaigns, attacks, and tasks while providing real-time monitoring and resource management.

**Context**: HashHive is a 2026 TypeScript reimplementation of [CipherSwarm](https://github.com/unclesp1d3r/CipherSwarm), serving as both a functional tool and a technology evaluation exercise. It runs in a private lab environment managing 7 cracking rigs.

## Core Capabilities

- **Agent Management**: Register, monitor, and coordinate distributed cracking agents with capability detection
- **Campaign Orchestration**: Create and manage multi-attack campaigns with DAG-based dependencies
- **Task Distribution**: Intelligent task assignment based on agent capabilities and keyspace partitioning
- **Resource Management**: Handle hash lists, wordlists, rulelists, and masklists
- **Real-time Monitoring**: Live dashboards for agent status, campaign progress, and crack results
- **Project Multi-tenancy**: Project-scoped access control with role-based permissions

## Target Users

- **Admins**: Global system administration, user and project management
- **Power-users**: Project-level administration, campaign orchestration, resource management
- **Users**: Campaign creation, resource usage, result review and analysis

## Operational Context

- **Air-gapped production environment**: The only supported deployment method is **Docker Compose**. All services (backend, frontend, PostgreSQL, Redis, SeaweedFS) run as containers that MUST operate without Internet access. All container images, dependencies, and resources must be fully self-contained. Development and testing occur on Internet-connected systems, but no runtime functionality may depend on external network access.
- **Private lab environment**: Minimum 10 cracking nodes (~25x RTX 4090 GPU capacity), not publicly exposed. Current dev baseline is 7 rigs, but production target is 10+.
- **Large attack resources**: Individual wordlists, masklists, and rulelists can exceed 100 GB. Upload, storage, download, and streaming pipelines must handle files of this scale without full-file buffering. S3 multipart upload/download and chunked transfer are required, not optional.
- **Low sustained load**: Periodic bursts when rigs submit results, request work, and send heartbeats
- **Low-traffic Dashboard**: 1-3 concurrent human users monitoring progress
- **LAN-connected agents**: Trusted agent environment on an isolated network
- **Hashcat compatibility**: 6.x baseline with 7.x expansion path
- **Optimize for**: Correctness, clarity, and developer experience (not premature scale)

## Reference Implementation

CipherSwarm's architecture, data models, and agent communication patterns are the source of truth for functional requirements. The Go-based hashcat-agent is the primary API consumer.
