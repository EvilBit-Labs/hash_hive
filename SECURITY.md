# Security Policy

## Project Context

HashHive is a distributed password cracking orchestration platform designed for LAN-connected, trusted agent environments. This is a test/development project based on the CipherSwarm architecture, maintained by a single part-time developer.

**Important**: HashHive is intended for authorized security testing and research purposes only. Users are responsible for ensuring compliance with applicable laws and regulations.

**Maintenance Notice**: This project is maintained on a part-time basis. Response times for security issues may vary based on maintainer availability. For critical production deployments, consider forking and establishing your own security response process.

## Supported Versions

HashHive is currently in active development as a greenfield MERN stack implementation. Security updates will be applied to the following versions:

| Version | Status | Support |
| ------- | ------ | ------- |
| 0.x.x (development) | 🚧 In Development | Active security fixes |
| Legacy CipherSwarm | ⚠️ Reference Only | Not supported |

Once HashHive reaches production readiness, this table will be updated to reflect stable release versions.

## Security Considerations

### Deployment Model

**HashHive is explicitly designed for private, LAN-only deployments and should NEVER be exposed to the internet.**

The security model assumes:

- Deployment within a trusted, isolated LAN environment
- No direct internet exposure of any HashHive components
- Agents are trusted and authenticated via secure tokens
- Network communication occurs within a controlled perimeter
- Object storage (S3-compatible) is secured and access-controlled
- MongoDB and Redis instances are isolated on private networks
- Physical or network-level access controls protect the deployment

**Internet Exposure Warning**: HashHive lacks the security hardening required for internet-facing deployments. Exposing HashHive to the internet will result in serious security vulnerabilities. Use VPN, SSH tunneling, or other secure remote access methods if external access is required.

### Authentication & Authorization

- **Web UI**: Session-based authentication with HttpOnly cookies
- **Agent API**: Pre-shared token authentication with API version headers
- **Project-scoped access**: Role-based permissions (admin, power-user, user)

### Data Protection

- Passwords are hashed using bcrypt with appropriate work factors
- Sensitive configuration values should be stored in environment variables
- Session tokens and JWT secrets must be cryptographically secure
- Object storage credentials should follow least-privilege principles

## Reporting a Vulnerability

Security issues are taken seriously, though please note this project is maintained part-time by a single developer. If you discover a security vulnerability in HashHive, please report it responsibly.

### How to Report

**Do not** open a public GitHub issue for security vulnerabilities.

Instead, please report security issues via:

- **GitHub Security Advisories** (preferred): Use the "Security" tab in this repository to privately report a vulnerability

For urgent critical vulnerabilities requiring immediate attention, consider also opening a discussion or checking if the maintainer is available via GitHub profile contact methods.

### What to Include

When reporting a vulnerability, please provide:

- A clear description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Affected versions or components (backend, frontend, agent API, etc.)
- Any proof-of-concept code or screenshots (if applicable)
- Your assessment of severity (if known)
- Whether the issue applies to the intended LAN-only deployment model

**Note**: Issues that only apply to internet-facing deployments are out of scope, as HashHive is not designed for such use. However, vulnerabilities exploitable within a trusted LAN are still relevant and should be reported.

### Response Timeline

Given the part-time maintenance model, response times are best-effort:

- **Initial Response**: Target within 7 days, though may vary based on maintainer availability
- **Status Updates**: As progress is made, typically every 2-4 weeks
- **Fix Timeline**: Depends on severity and maintainer capacity
  - Critical: Best effort within 30 days
  - High: Best effort within 60 days
  - Medium/Low: Addressed in future releases as time permits

**Note**: For production deployments requiring guaranteed response times, consider establishing your own fork with dedicated security support.

### Disclosure Policy

- Coordinated disclosure is preferred when possible
- Security fixes will be released when ready and tested
- Public disclosure timing will be coordinated with reporters when feasible
- Reporters will be credited in release notes (unless anonymity is requested)
- Given limited maintainer bandwidth, reporters are encouraged to contribute patches if able

## Security Best Practices for Deployments

When deploying HashHive, follow these security guidelines:

### Infrastructure

- **Never expose HashHive to the internet** - deploy on isolated LANs only
- Use firewall rules to restrict access to authorized networks
- Use TLS/SSL for HTTP traffic if operating on untrusted LAN segments
- Isolate PostgreSQL, Redis, and the object store on private networks
- Enable authentication and access controls on all infrastructure services
- Regularly update dependencies and base container images
- Use secrets management solutions (e.g., HashiCorp Vault, AWS Secrets Manager)
- For remote access, use VPN, SSH tunneling, or jump hosts - never direct exposure

### Configuration

- Never commit `.env` files or secrets to version control
- Rotate JWT secrets and API tokens periodically
- Set appropriate session timeouts and token expiration
- Enable audit logging for sensitive operations
- Configure rate limiting on API endpoints

### Monitoring

- Monitor for unusual agent behavior or authentication failures
- Set up alerts for failed login attempts and authorization errors
- Track resource access patterns for anomaly detection
- Maintain audit logs for compliance and forensics

### Agent Security

- Validate agent capabilities and hardware profiles on registration
- Implement agent heartbeat timeouts to detect compromised agents
- Use secure channels for task distribution and result reporting
- Sanitize and validate all agent-submitted data

## Known Limitations

As a part-time development project designed for LAN-only deployment, HashHive has the following known limitations:

- **Not designed for internet exposure** - lacks security controls for untrusted networks
- Limited rate limiting and DDoS protection
- No built-in intrusion detection or prevention
- Minimal audit logging in early versions
- Security updates may be delayed due to part-time maintenance
- No formal security audit or penetration testing has been conducted
- Authentication assumes trusted network perimeter

**Deployment Warning**: HashHive is designed exclusively for private LAN environments. Do not expose HashHive to the internet. Users deploying HashHive should:

- Deploy behind firewalls with no internet-facing exposure
- Use VPN or SSH tunneling for remote access
- Conduct their own security audits appropriate to their threat model
- Implement network-level access controls
- Maintain their own fork with security patches if needed
- Have internal expertise to respond to security issues independently

## Security-Related Dependencies

HashHive relies on several security-critical dependencies:

- **bcrypt**: Password hashing
- **jsonwebtoken**: JWT token generation and validation
- **express-session** / **cookie-parser**: Session management
- **helmet**: HTTP security headers
- **zod**: Input validation and sanitization

Keep these dependencies updated and monitor security advisories for the Node.js ecosystem.

## Community Security Contributions

Given the part-time maintenance model, community contributions to security are especially valuable:

- Security-focused pull requests are welcome and will be prioritized for review
- Documentation improvements for security best practices are encouraged
- Sharing deployment security configurations helps the community
- Consider contributing security test cases or tooling

## Questions?

For general security questions or guidance on secure deployment practices, please open a discussion in the GitHub Discussions tab. Response times may vary based on maintainer availability. For urgent production security concerns, consider engaging professional security consultants familiar with MERN stack applications.
