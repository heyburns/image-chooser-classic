from __future__ import annotations

import random
from typing import Dict, List, Optional, Sequence

import torch

from server import PromptServer
from nodes import PreviewImage
from comfy.model_management import InterruptProcessingException

from .image_chooser_server import MessageBroker, Cancelled


def _flatten_latents(latents: Optional[Sequence[Dict]]) -> Optional[torch.Tensor]:
    if latents is None:
        return None
    samples: List[torch.Tensor] = []
    for latent in latents:
        sample = latent.get("samples")
        if sample is None:
            return None
        samples.append(sample)
    if not samples:
        return None
    return torch.cat(samples, dim=0)


class BaseChooser(PreviewImage):
    CATEGORY = "image_chooser"
    INPUT_IS_LIST = True
    OUTPUT_NODE = False
    FUNCTION = "func"

    _last_ic: Dict[str, float] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (
                    [
                        "Always pause",
                        "Repeat last selection",
                        "Only pause if batch",
                        "Progress first pick",
                        "Pass through",
                        "Take First n",
                        "Take Last n",
                    ],
                    {},
                ),
                "count": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1}),
            },
            "optional": {
                "images": ("IMAGE",),
                "latents": ("LATENT",),
                "masks": ("MASK",),
                "segs": ("SEGS",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, id, **kwargs):
        mode = kwargs.get("mode", ["Always pause"])
        node_id = str(id[0])
        if mode[0] == "Repeat last selection" and node_id in cls._last_ic:
            return cls._last_ic[node_id]
        elif mode[0] == "Always pause":
            return 0.0
        else:
            cls._last_ic[node_id] = random.random()
            return cls._last_ic[node_id]

    def chooser_type(self) -> str:
        return "single"

    def expects_segments(self) -> bool:
        return False

    def notify_frontend(self, context: Dict[str, object]) -> None:
        PromptServer.instance.send_sync("cg-image-chooser-classic-open", context)

    def func(self, id, **kwargs):
        count = int(kwargs.pop("count", [1])[0])
        mode = kwargs.pop("mode", ["Always pause"])[0]

        unique_id = str(id[0])
        display_id = unique_id.split(":", 1)[0]
        MessageBroker.bind_display_id(display_id, unique_id)

        stash = MessageBroker.stash_for(unique_id)

        doing_segs = "segs" in kwargs

        if "images" in kwargs:
            stash["images"] = kwargs["images"]
            stash["latents"] = kwargs.get("latents")
            stash["masks"] = kwargs.get("masks")
            stash["segs"] = kwargs.get("segs")
        else:
            kwargs["images"] = stash.get("images")
            kwargs["latents"] = stash.get("latents")
            kwargs["masks"] = stash.get("masks")
            kwargs["segs"] = stash.get("segs")

        if kwargs.get("images") is None:
            return (None, None, None, "", None)

        images_in = kwargs.pop("images")
        latents_in = kwargs.pop("latents", None)
        masks_in = kwargs.pop("masks", None)
        segs_in = kwargs.pop("segs", None)

        images_tensor = (
            torch.cat(images_in) if not doing_segs else [img[0, ...] for img in images_in]
        )
        masks_tensor = (
            torch.cat(masks_in) if masks_in is not None and masks_in != (None,) else None
        )
        latents_tensor = _flatten_latents(latents_in) if latents_in is not None else None

        batch = images_tensor.shape[0] if not doing_segs else len(images_tensor)

        for key in list(kwargs.keys()):
            kwargs[key] = kwargs[key][0]

        selection: Optional[List[int]] = None
        last_selection = MessageBroker.get_last_selection(unique_id)

        if mode == "Repeat last selection" and last_selection:
            selection = list(last_selection)
        elif mode == "Pass through":
            selection = list(range(batch))
        elif mode == "Take First n":
            selection = list(range(min(count, batch)))
        elif mode == "Take Last n":
            start = max(0, batch - count)
            selection = list(range(start, batch))
        elif mode == "Only pause if batch" and batch <= 1:
            selection = [0]
        elif mode == "Always pause":
            selection = None
        preview_payload = images_tensor
        ret = self.save_images(images=preview_payload, **kwargs)

        context = {
            "unique_id": unique_id,
            "display_id": display_id,
            "chooser_type": self.chooser_type(),
            "mode": mode,
            "count": count,
            "image_count": batch,
            "progress_first_pick": mode == "Progress first pick",
            "urls": ret["ui"]["images"],
            "has_latents": latents_tensor is not None,
            "has_masks": masks_tensor is not None,
            "has_segs": doing_segs,
        }

        if selection is None:
            self.notify_frontend(context)
            try:
                selection = MessageBroker.wait_for_message(unique_id, as_list=True)
            except Cancelled:
                raise InterruptProcessingException()

        selection = [idx for idx in selection if idx >= 0]
        MessageBroker.set_last_selection(unique_id, selection)

        if doing_segs and segs_in:
            segs_out = (
                segs_in[0][0],
                [segs_in[0][1][i] for i in selection if i < len(segs_in[0][1])],
            )
            return (None, None, None, ",".join(str(i) for i in selection), segs_out)

        return self._build_outputs(
            images_tensor=images_tensor,
            latents_tensor=latents_tensor,
            masks_tensor=masks_tensor,
            selection=selection,
        )

    def tensor_bundle(self, tensor: Optional[torch.Tensor], picks: Sequence[int]) -> Optional[torch.Tensor]:
        if tensor is None or len(picks) == 0:
            return None
        batch = tensor.shape[0]
        collect = [tensor[index % batch].unsqueeze(0) for index in picks]
        return torch.cat(collect, dim=0)

    def latent_bundle(
        self, latents: Optional[torch.Tensor], picks: Sequence[int]
    ) -> Optional[Dict[str, torch.Tensor]]:
        bundle = self.tensor_bundle(latents, picks)
        return {"samples": bundle} if bundle is not None else None

    def _build_outputs(
        self,
        *,
        images_tensor: torch.Tensor,
        latents_tensor: Optional[torch.Tensor],
        masks_tensor: Optional[torch.Tensor],
        selection: Sequence[int],
    ):
        images = self.tensor_bundle(images_tensor, selection)
        latents = self.latent_bundle(latents_tensor, selection)
        masks = self.tensor_bundle(masks_tensor, selection)
        selection_str = ",".join(str(i) for i in selection)
        return (images, latents, masks, selection_str, None)


class PreviewAndChooseClassic(BaseChooser):
    RETURN_TYPES = ("IMAGE", "LATENT", "MASK", "STRING", "SEGS")
    RETURN_NAMES = ("images", "latents", "masks", "selected", "segs")

    def chooser_type(self) -> str:
        return "classic_widget"

    def notify_frontend(self, context: Dict[str, object]) -> None:
        PromptServer.instance.send_sync("cg-image-chooser-classic-widget-channel", context)


class PreviewAndChoose(BaseChooser):
    RETURN_TYPES = ("IMAGE", "LATENT", "MASK", "STRING", "SEGS")
    RETURN_NAMES = ("images", "latents", "masks", "selected", "segs")


class SimpleChooser(PreviewAndChoose):
    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("images", "latents")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"images": ("IMAGE",)},
            "optional": {"latents": ("LATENT",)},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "id": "UNIQUE_ID"},
        }

    def func(self, **kwargs):
        outputs = super().func(**kwargs)
        return outputs[0], outputs[1]


class PreviewAndChooseDouble(BaseChooser):
    RETURN_TYPES = ("LATENT", "LATENT")
    RETURN_NAMES = ("positive", "negative")

    def chooser_type(self) -> str:
        return "double"

    def _build_outputs(
        self,
        *,
        images_tensor: torch.Tensor,
        latents_tensor: Optional[torch.Tensor],
        masks_tensor: Optional[torch.Tensor],
        selection: Sequence[int],
    ):
        if -1 in selection:
            divider = selection.index(-1)
            positive = selection[:divider]
            negative = selection[divider + 1 :]
        else:
            positive = selection
            negative = []

        latents_positive = self.latent_bundle(latents_tensor, positive)
        latents_negative = self.latent_bundle(latents_tensor, negative)
        return (latents_positive, latents_negative)
