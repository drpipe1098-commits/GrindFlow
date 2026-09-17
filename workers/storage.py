"""Descarga y subida de objetos en Cloudflare R2."""

from __future__ import annotations

from pathlib import Path

import boto3
from botocore.config import Config as BotoConfig

from config import Config


def build_client(config: Config):
    return boto3.client(
        "s3",
        endpoint_url=config.r2_endpoint,
        aws_access_key_id=config.r2_access_key_id,
        aws_secret_access_key=config.r2_secret_access_key,
        region_name=config.r2_region,
        config=BotoConfig(s3={"addressing_style": "path"}),
    )


def download(client, bucket: str, key: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    client.download_file(bucket, key, str(destination))
    return destination


def upload(client, bucket: str, key: str, source: Path, content_type: str) -> str:
    client.upload_file(
        str(source), bucket, key, ExtraArgs={"ContentType": content_type}
    )
    return key
