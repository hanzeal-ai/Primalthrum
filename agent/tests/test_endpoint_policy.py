import socket
import unittest

from runtime.endpoint_policy import (
    ProviderEndpointPolicyError,
    normalize_provider_base_url,
    secure_provider_base_url,
)


def address_record(value: str):
    family = socket.AF_INET6 if ":" in value else socket.AF_INET
    return (family, socket.SOCK_STREAM, 6, "", (value, 443))


class EndpointPolicyTest(unittest.TestCase):
    def test_normalization_rejects_private_metadata_and_ambiguous_urls(self) -> None:
        self.assertEqual(
            normalize_provider_base_url("https://API.EXAMPLE.com/v1/"),
            "https://api.example.com/v1",
        )
        for target in (
            "http://api.example.com/v1",
            "https://user:password@api.example.com/v1",
            "https://api.example.com/v1?next=metadata",
            "https://api.example.com/v1#fragment",
            "https://localhost/v1",
            "https://metadata.google.internal/computeMetadata/v1",
            "https://service.internal/v1",
            "https://127.0.0.1/v1",
            "https://10.0.0.1/v1",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/v1",
            "https://[fc00::1]/v1",
        ):
            with self.subTest(target=target):
                with self.assertRaises(ProviderEndpointPolicyError):
                    normalize_provider_base_url(target)

    def test_dns_preflight_rejects_private_and_mixed_answers(self) -> None:
        def public_resolver(*_args):
            return [address_record("8.8.8.8"), address_record("2606:4700:4700::1111")]

        self.assertEqual(
            secure_provider_base_url(
                "https://provider.example/v1",
                resolver=public_resolver,
            ),
            "https://provider.example/v1",
        )

        for answers in (
            [address_record("10.0.0.5")],
            [address_record("8.8.8.8"), address_record("169.254.169.254")],
        ):
            with self.assertRaises(ProviderEndpointPolicyError):
                secure_provider_base_url(
                    "https://provider.example/v1",
                    resolver=lambda *_args, values=answers: values,
                )

        with self.assertRaises(ProviderEndpointPolicyError):
            secure_provider_base_url(
                "https://provider.example/v1",
                resolver=lambda *_args: [],
            )


if __name__ == "__main__":
    unittest.main()
