# Uma mídia por campanha (V1)

## Integração e limites

Baileys instalado: @whiskeysockets/baileys 7.0.0-rc14. AnyMediaMessageContent suporta image/video com caption; WAMediaUpload aceita Buffer. O worker envia uma única mensagem com arquivo e legenda e persiste seu único providerId. Texto puro continua usando exatamente { text }. Não há transcodificação nem divisão da legenda em mensagens extras.

Fontes consultadas:
- https://github.com/WhiskeySockets/Baileys/blob/master/README.md#media-messages
- https://faq.whatsapp.com/453914586839706/ (limites de vídeo do aplicativo variam: 64 MB ou 100 MB conforme condições).
- https://faq.whatsapp.com/425247423114725/ (referência de compartilhamento de imagens: 16 MB; não é contrato de protocolo do Baileys).

O Baileys não declara um limite universal garantido. Política de compatibilidade desta V1: JPEG/PNG estáticos até 16.000.000 bytes, MP4 H.264 e no máximo uma faixa AAC opcional até 64.000.000 bytes. São limites conservadores da aplicação, não limites da Cloud API nem garantia de aceitação pelo WhatsApp. SVG/GIF/HEIC/MOV e outros formatos não são convertidos nesta etapa. Imagens também têm limite de segurança de 32 milhões de pixels para evitar consumo excessivo de memória. O decoder sharp valida as imagens; ffprobe valida container/faixas/codecs sem permitir protocolos externos. O WhatsApp ainda pode rejeitar arquivos/legendas específicos; validar ponta a ponta antes de campanhas reais. Texto existente não é truncado.

## Persistência e implantação futura

Migration aditiva 20260920000100_campaign_media cria CampaignMedia (BYTEA, metadados) e Campaign.mediaId nullable com FK RESTRICT. Campanhas antigas permanecem sem mídia. Não altera entregas, IDs da fila ou recibos. Metadados são expostos nos detalhes, nunca os bytes em listagens JSON. GET /media/:id oferece bytes e Range para preview de vídeo.

O PostgreSQL é a fonte persistente; o volume postgres_data já existente deve ser mantido e incluído nos backups. API e worker em hosts diferentes precisam apenas acessar o mesmo banco; não dependem de caminho local ou diretório temporário. Bytes são imutáveis. Trocar/remover somente em rascunhos; uma campanha iniciada preserva a referência usada pelo histórico. Campanhas excluídas logicamente mantêm mídia e histórico. Upload confirmado seguido de formulário abandonado/erro pode deixar mídia sem campanha: não há coleta automática/destrutiva nesta V1. Considere o tamanho dos backups. O endpoint é local e segue as mesmas restrições de origem/host da API; não expor publicamente sem segurança adequada.

Dependências: sharp na API e worker, ffprobe-static na API. O binário de validação acompanha o pacote; a plataforma de hospedagem deve ser suportada por ele. Não é necessário instalar ffmpeg para enviar vídeo; a miniatura opcional do Baileys pode não ser gerada se ffmpeg não existir, sem afetar o conteúdo da mensagem. A fixture de teste é um MP4 preto 16x16 gerado, sem conteúdo do usuário. Não há envio real nos testes.

## Teste real pendente

Com autorização, enviar uma campanha de teste de texto, uma PNG/JPEG e uma MP4 H.264/AAC para um grupo consentido. Confirmar arquivo reproduzível, legenda íntegra, apenas uma mensagem, um providerId e recibos atribuídos à mesma entrega. Os testes automatizados usam banco isolado e socket simulado; não comprovam entrega no WhatsApp nem recepção de recibos reais.
