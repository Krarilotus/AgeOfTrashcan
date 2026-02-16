from .config import OvernightConfig, PPOConfig, RuntimeConfig

__all__ = [
    "OvernightConfig",
    "PPOConfig",
    "RuntimeConfig",
    "SelfPlayTrainer",
]


def __getattr__(name: str):
    if name == "SelfPlayTrainer":
        from .trainer import SelfPlayTrainer as _SelfPlayTrainer

        return _SelfPlayTrainer
    raise AttributeError(f"module 'selfplay' has no attribute {name!r}")
