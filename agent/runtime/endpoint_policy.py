from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Callable, Sequence
from urllib.parse import SplitResult, urlsplit, urlunsplit


AddressInfo = tuple[int, int, int, str, tuple[object, ...]]
AddressResolver = Callable[..., Sequence[AddressInfo]]

_FORBIDDEN_HOSTNAMES = {
    "instance-data",
    "metadata",
    "metadata.google.internal",
}
_FORBIDDEN_SUFFIXES = (".home.arpa", ".internal", ".local", ".localhost")


class ProviderEndpointPolicyError(ValueError):
    pass


def normalize_provider_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise ProviderEndpointPolicyError("provider base_url must be a valid URL") from error
    if parsed.scheme.lower() != "https":
        raise ProviderEndpointPolicyError("provider base_url must use HTTPS")
    if parsed.username or parsed.password:
        raise ProviderEndpointPolicyError("provider base_url cannot include credentials")
    if parsed.query or parsed.fragment:
        raise ProviderEndpointPolicyError(
            "provider base_url cannot include a query or fragment"
        )
    if not parsed.hostname:
        raise ProviderEndpointPolicyError("provider base_url hostname is required")

    try:
        hostname = parsed.hostname.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise ProviderEndpointPolicyError("provider base_url hostname is invalid") from error
    _assert_allowed_hostname(hostname)
    _assert_global_address(hostname, allow_hostname=True)

    authority_host = f"[{hostname}]" if ":" in hostname else hostname
    authority = f"{authority_host}:{port}" if port is not None else authority_host
    normalized = SplitResult("https", authority, parsed.path or "", "", "")
    return urlunsplit(normalized).rstrip("/")


def secure_provider_base_url(
    value: str,
    *,
    resolve_dns: bool = True,
    resolver: AddressResolver = socket.getaddrinfo,
) -> str:
    normalized = normalize_provider_base_url(value)
    if resolve_dns:
        _validate_resolved_addresses(normalized, resolver)
    return normalized


async def secure_provider_base_url_async(
    value: str,
    *,
    resolve_dns: bool = True,
    resolver: AddressResolver = socket.getaddrinfo,
) -> str:
    if not resolve_dns:
        return normalize_provider_base_url(value)
    return await asyncio.to_thread(
        secure_provider_base_url,
        value,
        resolve_dns=True,
        resolver=resolver,
    )


def _validate_resolved_addresses(value: str, resolver: AddressResolver) -> None:
    parsed = urlsplit(value)
    hostname = parsed.hostname or ""
    if _ip_address(hostname) is not None:
        return
    try:
        records = resolver(
            hostname,
            parsed.port or 443,
            socket.AF_UNSPEC,
            socket.SOCK_STREAM,
        )
    except OSError as error:
        raise ProviderEndpointPolicyError(
            "provider base_url hostname could not be resolved safely"
        ) from error
    if not records:
        raise ProviderEndpointPolicyError("provider base_url hostname did not resolve")
    for record in records:
        try:
            address = str(record[4][0])
        except (IndexError, TypeError) as error:
            raise ProviderEndpointPolicyError(
                "provider base_url returned an invalid DNS address"
            ) from error
        _assert_global_address(address)


def _assert_allowed_hostname(hostname: str) -> None:
    if (
        hostname == "localhost"
        or hostname in _FORBIDDEN_HOSTNAMES
        or hostname.endswith(_FORBIDDEN_SUFFIXES)
    ):
        raise ProviderEndpointPolicyError(
            "provider base_url cannot target a private or metadata hostname"
        )


def _assert_global_address(value: str, *, allow_hostname: bool = False) -> None:
    address = _ip_address(value)
    if address is None:
        if allow_hostname:
            return
        raise ProviderEndpointPolicyError("provider base_url resolved to an invalid address")
    if not address.is_global:
        raise ProviderEndpointPolicyError(
            "provider base_url cannot target a private or reserved address"
        )


def _ip_address(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address
